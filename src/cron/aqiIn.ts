import { fetchAqiReading, type AqiReading } from "../aqi-in/client";
import type { Env } from "../env";
import { aqiUsFromPm25 } from "../utils/aqi";
import { writeSample } from "../utils/samples";
import { minuteBucketTimestamp } from "../utils/time";

export const AQI_IN_CRON = "*/10 * * * *";
export const AQI_IN_DEVICE_ID = "bellezea-outdoor";
const MAX_SAMPLE_AGE_MS = 30 * 60_000;

export async function runAqiInPoll(
  env: Env,
  nowMs: number = Date.now(),
  read: () => Promise<AqiReading> = fetchAqiReading,
): Promise<void> {
  const reading = await read();
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
    pm25_ugm3: reading.metrics.pm25_ugm3,
    pm10_ugm3: reading.metrics.pm10_ugm3,
    noise_db: reading.metrics.noise_db,
    voc_ppm: reading.metrics.tvoc_ppm,
    aqi_us: aqi,
  });
  console.log(JSON.stringify({
    event: "aqi_in_stored",
    device_id: AQI_IN_DEVICE_ID,
    observed_at: reading.observedAt,
    ts,
    pm25_ugm3: reading.metrics.pm25_ugm3,
    aqi_us: aqi,
  }));
}
