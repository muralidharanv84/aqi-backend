import type { Env } from "../env";
import { lastCompletedHourWindow } from "../utils/time";

type DeviceRow = {
  device_id: string;
  timezone: string;
};

type AggregateRow = {
  n: number;
  pm25_avg: number | null;
  pm25_min: number | null;
  pm25_max: number | null;
  aqi_avg: number | null;
  aqi_min: number | null;
  aqi_max: number | null;
  co2_avg: number | null;
  co2_min: number | null;
  co2_max: number | null;
  voc_ppm_avg: number | null;
  voc_ppm_min: number | null;
  voc_ppm_max: number | null;
  voc_index_avg: number | null;
  voc_index_min: number | null;
  voc_index_max: number | null;
  temp_avg: number | null;
  temp_min: number | null;
  temp_max: number | null;
  rh_avg: number | null;
  rh_min: number | null;
  rh_max: number | null;
};

const AGGREGATE_SQL = `
  SELECT
    COUNT(*) AS n,
    AVG(pm25_ugm3) AS pm25_avg,
    MIN(pm25_ugm3) AS pm25_min,
    MAX(pm25_ugm3) AS pm25_max,
    AVG(aqi_us) AS aqi_avg,
    MIN(aqi_us) AS aqi_min,
    MAX(aqi_us) AS aqi_max,
    AVG(co2_ppm) AS co2_avg,
    MIN(co2_ppm) AS co2_min,
    MAX(co2_ppm) AS co2_max,
    AVG(voc_ppm) AS voc_ppm_avg,
    MIN(voc_ppm) AS voc_ppm_min,
    MAX(voc_ppm) AS voc_ppm_max,
    AVG(voc_index) AS voc_index_avg,
    MIN(voc_index) AS voc_index_min,
    MAX(voc_index) AS voc_index_max,
    AVG(temp_c) AS temp_avg,
    MIN(temp_c) AS temp_min,
    MAX(temp_c) AS temp_max,
    AVG(rh_pct) AS rh_avg,
    MIN(rh_pct) AS rh_min,
    MAX(rh_pct) AS rh_max
  FROM samples_raw
  WHERE device_id = ?
    AND ts >= ?
    AND ts < ?
`;

const UPSERT_SQL = `
  INSERT INTO samples_hourly (
    device_id,
    hour_ts,
    pm25_avg,
    pm25_min,
    pm25_max,
    aqi_avg,
    aqi_min,
    aqi_max,
    co2_avg,
    co2_min,
    co2_max,
    voc_ppm_avg,
    voc_ppm_min,
    voc_ppm_max,
    voc_index_avg,
    voc_index_min,
    voc_index_max,
    temp_avg,
    temp_min,
    temp_max,
    rh_avg,
    rh_min,
    rh_max,
    n
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(device_id, hour_ts) DO UPDATE SET
    pm25_avg = excluded.pm25_avg,
    pm25_min = excluded.pm25_min,
    pm25_max = excluded.pm25_max,
    aqi_avg = excluded.aqi_avg,
    aqi_min = excluded.aqi_min,
    aqi_max = excluded.aqi_max,
    co2_avg = excluded.co2_avg,
    co2_min = excluded.co2_min,
    co2_max = excluded.co2_max,
    voc_ppm_avg = excluded.voc_ppm_avg,
    voc_ppm_min = excluded.voc_ppm_min,
    voc_ppm_max = excluded.voc_ppm_max,
    voc_index_avg = excluded.voc_index_avg,
    voc_index_min = excluded.voc_index_min,
    voc_index_max = excluded.voc_index_max,
    temp_avg = excluded.temp_avg,
    temp_min = excluded.temp_min,
    temp_max = excluded.temp_max,
    rh_avg = excluded.rh_avg,
    rh_min = excluded.rh_min,
    rh_max = excluded.rh_max,
    n = excluded.n
`;

export async function aggregateCompletedHours(
  env: Env,
  nowMs: number = Date.now(),
): Promise<void> {
  const devices = await env.DB
    .prepare("SELECT device_id, timezone FROM devices")
    .all<DeviceRow>();

  for (const device of devices.results ?? []) {
    const window = lastCompletedHourWindow(nowMs, device.timezone);

    const aggregate = await env.DB
      .prepare(AGGREGATE_SQL)
      .bind(device.device_id, window.startTs, window.endTs)
      .first<AggregateRow>();

    if (!aggregate || aggregate.n === 0) continue;

    await env.DB
      .prepare(UPSERT_SQL)
      .bind(
        device.device_id,
        window.startTs,
        aggregate.pm25_avg,
        aggregate.pm25_min,
        aggregate.pm25_max,
        aggregate.aqi_avg,
        aggregate.aqi_min,
        aggregate.aqi_max,
        aggregate.co2_avg,
        aggregate.co2_min,
        aggregate.co2_max,
        aggregate.voc_ppm_avg,
        aggregate.voc_ppm_min,
        aggregate.voc_ppm_max,
        aggregate.voc_index_avg,
        aggregate.voc_index_min,
        aggregate.voc_index_max,
        aggregate.temp_avg,
        aggregate.temp_min,
        aggregate.temp_max,
        aggregate.rh_avg,
        aggregate.rh_min,
        aggregate.rh_max,
        aggregate.n,
      )
      .run();
  }
}
