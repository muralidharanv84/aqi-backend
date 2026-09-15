import { fetchAqiReading } from "../../src/aqi-in/client";

/** Standalone example. Logs readings; add your chosen storage at the indicated line. */
export default {
  async scheduled(_event: ScheduledController, _env: unknown, ctx: ExecutionContext) {
    ctx.waitUntil(poll());
  },
} satisfies ExportedHandler;

async function poll(): Promise<void> {
  const reading = await fetchAqiReading();
  const ageMs = Date.parse(reading.fetchedAt) - Date.parse(reading.observedAt);
  if (!reading.online || ageMs > 30 * 60_000) {
    console.warn(JSON.stringify({ event: "aqi_in_stale", uid: reading.uid, observedAt: reading.observedAt }));
    return;
  }
  // Store here, using (uid, observedAt) as the deduplication key.
  console.log(JSON.stringify({ event: "aqi_in_reading", ...reading }));
}
