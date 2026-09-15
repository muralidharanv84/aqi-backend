import type { Env } from "../env";
import { aggregateBucketSql, chooseAggregateResolution, hourlyColumns, parseSeriesQuery } from "../utils/series";
import type { SeriesResolution } from "../utils/series";

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

  if (parsed.resolution === "5m") {
    const points = await env.DB.prepare(
      `SELECT CAST(ts / 300 AS INTEGER) * 300 AS bucket_ts,
              AVG(${parsed.metric}) AS avg, MIN(${parsed.metric}) AS min,
              MAX(${parsed.metric}) AS max, COUNT(*) AS n
       FROM samples_raw
       WHERE device_id = ? AND ts >= ? AND ts <= ? AND ${parsed.metric} IS NOT NULL
       GROUP BY bucket_ts ORDER BY bucket_ts ASC`,
    ).bind(deviceId, parsed.from, parsed.to)
      .all<{ bucket_ts: number; avg: number; min: number; max: number; n: number }>();
    return Response.json({
      metric: parsed.metric, resolution: parsed.resolution,
      points: (points.results ?? []).map(({ bucket_ts, ...point }) => ({ ts: bucket_ts, ...point })),
    });
  }

  const cols = hourlyColumns(parsed.metric);
  let resolution: Exclude<SeriesResolution, "raw" | "5m">;
  if (parsed.resolution === "auto") {
    // Use the device's actual history for All time, rather than its Unix-epoch
    // request bound. All metrics share the same periods when overlaid.
    const extent = await env.DB.prepare(
      `SELECT MIN(hour_ts) AS first_ts, MAX(hour_ts) AS last_ts
       FROM samples_hourly WHERE device_id = ? AND hour_ts >= ? AND hour_ts <= ?`,
    ).bind(deviceId, parsed.from, parsed.to)
      .first<{ first_ts: number | null; last_ts: number | null }>();
    resolution = chooseAggregateResolution(
      parsed.from === 0 ? extent?.first_ts ?? parsed.to : parsed.from,
      parsed.from === 0 ? extent?.last_ts ?? parsed.to : parsed.to,
    );
  } else {
    resolution = parsed.resolution;
  }

  if (resolution !== "1h") {
    const points = await env.DB.prepare(
      `SELECT ${aggregateBucketSql(resolution)} AS ts,
              SUM(${cols.avg} * n) / SUM(n) AS avg,
              MIN(${cols.min}) AS min,
              MAX(${cols.max}) AS max,
              SUM(n) AS n
       FROM samples_hourly
       WHERE device_id = ? AND hour_ts >= ? AND hour_ts <= ?
         AND ${cols.avg} IS NOT NULL AND n > 0
       GROUP BY ts ORDER BY ts ASC`,
    ).bind(deviceId, parsed.from, parsed.to).all<HourlyPoint>();

    return Response.json({ metric: parsed.metric, resolution, points: points.results ?? [] });
  }

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
    resolution,
    points: points.results ?? [],
  });
}
