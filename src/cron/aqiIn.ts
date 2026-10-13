import { fetchAqiReading, type AqiReading } from "../aqi-in/client";
import type { Env } from "../env";
import { aqiUsFromPm25 } from "../utils/aqi";
import { writeSample } from "../utils/samples";
import { minuteBucketTimestamp } from "../utils/time";

export const AQI_IN_CRON = "* * * * *";
export const AQI_IN_DEVICE_ID = "bellezea-outdoor";
const MAX_SAMPLE_AGE_MS = 30 * 60_000;

export async function runAqiInPoll(
  env: Env,
  nowMs: number = Date.now(),
  read?: () => Promise<AqiReading>,
): Promise<void> {
  let reading: AqiReading;
  let source: "private" | "public" = "public";
  if (read) reading = await read();
  else if (env.AQI_SESSION) {
    const response = await env.AQI_SESSION.get(env.AQI_SESSION.idFromName(AQI_IN_DEVICE_ID)).fetch("https://session/read");
    if (!response.ok) throw new Error("AQI session service failed");
    const result = await response.json<import("../aqi-in/session").ReadResult | null>();
    if (!result) return;
    reading = result.reading; source = result.source;
  } else reading = await fetchAqiReading();
  const observedMs = Date.parse(reading.observedAt);
  if (!reading.online || nowMs - observedMs > MAX_SAMPLE_AGE_MS) {
    console.warn(JSON.stringify({
      event: "aqi_in_skipped_stale",
      device_id: AQI_IN_DEVICE_ID,
      observed_at: reading.observedAt,
      online: reading.online,
    }));
    return;
  }

  const ts = minuteBucketTimestamp(observedMs);
  const aqi = aqiUsFromPm25(reading.metrics.pm25_ugm3);
  await writeSample(env.DB, AQI_IN_DEVICE_ID, ts, {
    temp_c: reading.metrics.temp_c,
    rh_pct: reading.metrics.rh_pct,
    pm25_ugm3: reading.metrics.pm25_ugm3,
    pm10_ugm3: reading.metrics.pm10_ugm3,
    noise_db: reading.metrics.noise_db,
    voc_ppm: reading.metrics.tvoc_ppm,
    aqi_us: aqi,
  }, source === "public" ? "keep-existing" : "replace");
  console.log(JSON.stringify({
    event: "aqi_in_stored",
    source,
    device_id: AQI_IN_DEVICE_ID,
    observed_at: reading.observedAt,
    ts,
    pm25_ugm3: reading.metrics.pm25_ugm3,
    aqi_us: aqi,
  }));
}
