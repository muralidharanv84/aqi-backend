import type { Env } from "../env";
import { verifyDeviceRequest } from "../utils/auth";
import { parseMetrics } from "../utils/metrics";
import { minuteBucketTimestamp } from "../utils/time";

const INSERT_SAMPLE_SQL = `
  INSERT INTO samples_raw (
    device_id,
    ts,
    pm25_ugm3,
    aqi_us,
    co2_ppm,
    voc_ppm,
    voc_index,
    temp_c,
    rh_pct
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(device_id, ts) DO UPDATE SET
    pm25_ugm3 = excluded.pm25_ugm3,
    aqi_us = excluded.aqi_us,
    co2_ppm = excluded.co2_ppm,
    voc_ppm = excluded.voc_ppm,
    voc_index = excluded.voc_index,
    temp_c = excluded.temp_c,
    rh_pct = excluded.rh_pct
`;

function badRequest(message: string): Response {
  return Response.json({ ok: false, error: message }, { status: 400 });
}

export async function handleIngest(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") {
    return Response.json({ ok: false }, { status: 405 });
  }

  const auth = await verifyDeviceRequest(req, env);
  if (!auth.ok) return auth.response;
  const { deviceId, body: rawBody } = auth;

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return badRequest("Invalid JSON");
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return badRequest("Invalid JSON");
  }

  const parsed = parseMetrics(payload as Record<string, unknown>);
  if ("error" in parsed) return badRequest(parsed.error);

  const ts = minuteBucketTimestamp(Date.now());

  await env.DB
    .prepare(INSERT_SAMPLE_SQL)
    .bind(
      deviceId,
      ts,
      parsed.metrics.pm25_ugm3 ?? null,
      parsed.metrics.aqi_us ?? null,
      parsed.metrics.co2_ppm ?? null,
      parsed.metrics.voc_ppm ?? null,
      parsed.metrics.voc_index ?? null,
      parsed.metrics.temp_c ?? null,
      parsed.metrics.rh_pct ?? null,
    )
    .run();

  return Response.json({ ok: true, ts });
}
