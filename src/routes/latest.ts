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

type FanControlLogRow = {
  run_ts: number;
  run_status: "success" | "skipped_stale" | "error";
  winix_device_id: string | null;
  effective_speed: string | null;
  error_message: string | null;
  error_streak: number;
};

type FanControlPayload = {
  latest_event: {
    run_ts: number;
    status: "success" | "skipped_stale" | "error";
    purifier_device_ids: string[];
    speed: string | null;
    error_message: string | null;
  } | null;
  latest_error: {
    run_ts: number;
    status: "skipped_stale" | "error";
    message: string;
    error_streak: number;
  } | null;
};

function parseDeviceIds(csv: string | null): string[] {
  if (!csv) return [];
  return csv
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

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

  const latestFanControl = await env.DB
    .prepare(
      `SELECT run_ts, run_status, winix_device_id, effective_speed, error_message, error_streak
       FROM winix_control_log
       WHERE monitor_device_id = ?
       ORDER BY id DESC
       LIMIT 1`,
    )
    .bind(deviceId)
    .first<FanControlLogRow>();

  const latestFanControlError = await env.DB
    .prepare(
      `SELECT run_ts, run_status, error_message, error_streak
       FROM winix_control_log
       WHERE monitor_device_id = ?
         AND error_message IS NOT NULL
       ORDER BY id DESC
       LIMIT 1`,
    )
    .bind(deviceId)
    .first<FanControlLogRow>();

  const fanControl: FanControlPayload = {
    latest_event: latestFanControl
      ? {
          run_ts: latestFanControl.run_ts,
          status: latestFanControl.run_status,
          purifier_device_ids: parseDeviceIds(latestFanControl.winix_device_id),
          speed: latestFanControl.effective_speed,
          error_message: latestFanControl.error_message,
        }
      : null,
    latest_error:
      latestFanControlError && latestFanControlError.error_message
        ? {
            run_ts: latestFanControlError.run_ts,
            status:
              latestFanControlError.run_status === "error" ? "error" : "skipped_stale",
            message: latestFanControlError.error_message,
            error_streak: latestFanControlError.error_streak,
          }
        : null,
  };

  return Response.json({
    device_id: row.device_id,
    ts: row.ts,
    metrics,
    fan_control: fanControl,
  });
}
