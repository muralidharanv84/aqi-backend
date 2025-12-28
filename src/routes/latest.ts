import type { Env } from "../env";
import { METRIC_FIELDS } from "../utils/metrics";

type SampleRow = {
  device_id: string;
  ts: number;
  pm25_ugm3: number | null;
  aqi_us: number | null;
  co2_ppm: number | null;
  voc_ppm: number | null;
  voc_index: number | null;
  temp_c: number | null;
  rh_pct: number | null;
};

function methodNotAllowed(): Response {
  return Response.json({ ok: false }, { status: 405 });
}

export async function handleLatest(
  req: Request,
  env: Env,
  deviceId: string,
): Promise<Response> {
  if (req.method !== "GET") return methodNotAllowed();

  const row = await env.DB
    .prepare(
      "SELECT * FROM samples_raw WHERE device_id = ? ORDER BY ts DESC LIMIT 1",
    )
    .bind(deviceId)
    .first<SampleRow>();

  if (!row) return Response.json({ ok: false }, { status: 404 });

  const metrics: Record<string, number> = {};
  for (const field of METRIC_FIELDS) {
    const value = row[field];
    if (value !== null && value !== undefined) metrics[field] = value;
  }

  return Response.json({
    device_id: row.device_id,
    ts: row.ts,
    metrics,
  });
}
