import type { Env } from "../env";
import { hourlyColumns, parseSeriesQuery } from "../utils/series";

type RawPoint = { ts: number; value: number };
type HourlyPoint = { ts: number; avg: number; min: number; max: number; n: number };

function methodNotAllowed(): Response {
  return Response.json({ ok: false }, { status: 405 });
}

function badRequest(message: string): Response {
  return Response.json({ ok: false, error: message }, { status: 400 });
}

export async function handleSeries(
  req: Request,
  env: Env,
  deviceId: string,
  url: URL,
): Promise<Response> {
  if (req.method !== "GET") return methodNotAllowed();

  const parsed = parseSeriesQuery(url);
  if ("error" in parsed) return badRequest(parsed.error);

  if (parsed.resolution === "raw") {
    const points = await env.DB
      .prepare(
        `SELECT ts, ${parsed.metric} AS value
         FROM samples_raw
         WHERE device_id = ?
           AND ts >= ?
           AND ts <= ?
           AND ${parsed.metric} IS NOT NULL
         ORDER BY ts ASC`,
      )
      .bind(deviceId, parsed.from, parsed.to)
      .all<RawPoint>();

    return Response.json({
      metric: parsed.metric,
      resolution: parsed.resolution,
      points: points.results ?? [],
    });
  }

  const cols = hourlyColumns(parsed.metric);
  const points = await env.DB
    .prepare(
      `SELECT hour_ts AS ts,
              ${cols.avg} AS avg,
              ${cols.min} AS min,
              ${cols.max} AS max,
              n
       FROM samples_hourly
       WHERE device_id = ?
         AND hour_ts >= ?
         AND hour_ts <= ?
         AND ${cols.avg} IS NOT NULL
       ORDER BY hour_ts ASC`,
    )
    .bind(deviceId, parsed.from, parsed.to)
    .all<HourlyPoint>();

  return Response.json({
    metric: parsed.metric,
    resolution: parsed.resolution,
    points: points.results ?? [],
  });
}
