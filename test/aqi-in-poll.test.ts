import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { type AqiReading, MUTHANALLUR } from "../src/aqi-in/client";
import { aggregateCompletedHours } from "../src/cron/aggregate";
import { AQI_IN_CRON, AQI_IN_DEVICE_ID, runAqiInPoll } from "../src/cron/aqiIn";
import { handleRequest, runScheduledJobs } from "../src/index";
import type { Env } from "../src/env";
import { insertDevice, resetDb } from "./utils/db";

const nowMs = Date.parse("2026-09-15T03:40:00Z");
const runtimeEnv: Env = { DB: env.DB, WINIX_CONTROL_ENABLED: "false" };

function reading(pm25 = 3, observedAt = "2026-09-15T03:21:23.108Z"): AqiReading {
  return {
    ...MUTHANALLUR,
    observedAt,
    fetchedAt: new Date(nowMs).toISOString(),
    online: true,
    metrics: { pm25_ugm3: pm25, pm10_ugm3: 9, noise_db: 50, tvoc_ppm: 34.374 },
  };
}

describe("outdoor polling", () => {
  beforeEach(async () => {
    await resetDb(env.DB);
    await insertDevice(env.DB, AQI_IN_DEVICE_ID, "", "Asia/Kolkata");
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("writes all sensor metrics with firmware AQI and source time, idempotently", async () => {
    const read = vi.fn().mockResolvedValue(reading());
    await runAqiInPoll(runtimeEnv, nowMs, read);
    await runAqiInPoll(runtimeEnv, nowMs + 600_000, read);
    const rows = await env.DB.prepare("SELECT * FROM samples_raw").all();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toMatchObject({
      device_id: AQI_IN_DEVICE_ID,
      ts: Date.parse("2026-09-15T03:21:00Z") / 1000,
      pm25_ugm3: 3, pm10_ugm3: 9, noise_db: 50, voc_ppm: 34.374,
      aqi_us: 12, // Python round(12.5) is 12; JS Math.round would be 13.
      temp_c: null, rh_pct: null,
    });
    const response = await handleRequest(new Request(`https://example.com/api/v1/devices/${AQI_IN_DEVICE_ID}/latest`), runtimeEnv);
    expect(await response.json()).toMatchObject({
      device_id: AQI_IN_DEVICE_ID,
      metrics: { pm25_ugm3: 3, pm10_ugm3: 9, noise_db: 50, voc_ppm: 34.374, aqi_us: 12 },
    });
  });

  it.each(["offline", "stale"])("skips %s data", async kind => {
    const source = reading();
    if (kind === "offline") source.online = false;
    else source.observedAt = "2026-09-15T02:00:00Z";
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runAqiInPoll(runtimeEnv, nowMs, async () => source);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM samples_raw").first("n")).toBe(0);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("aqi_in_skipped_stale"));
  });

  it("leaves existing samples intact when the upstream fetch fails", async () => {
    await runAqiInPoll(runtimeEnv, nowMs, async () => reading());
    await expect(runAqiInPoll(runtimeEnv, nowMs, async () => { throw new Error("HTTP 429"); })).rejects.toThrow("HTTP 429");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM samples_raw").first("n")).toBe(1);
  });

  it("serves new fields through raw series and hourly aggregation", async () => {
    await runAqiInPoll(runtimeEnv, nowMs, async () => reading());
    const next = reading(9, "2026-09-15T03:29:23Z");
    next.metrics.pm10_ugm3 = 19;
    next.metrics.noise_db = 70;
    await runAqiInPoll(runtimeEnv, nowMs, async () => next);
    await aggregateCompletedHours(runtimeEnv, nowMs);
    const aggregate = await env.DB.prepare("SELECT * FROM samples_hourly WHERE device_id = ?")
      .bind(AQI_IN_DEVICE_ID).first();
    expect(aggregate).toMatchObject({ pm10_avg: 14, pm10_min: 9, pm10_max: 19, noise_avg: 60, noise_min: 50, noise_max: 70, aqi_avg: 25, n: 2 });
    for (const [metric, raw, avg] of [["pm10_ugm3", 9, 14], ["noise_db", 50, 60], ["aqi_us", 12, 25]] as const) {
      const path = `https://example.com/api/v1/devices/${AQI_IN_DEVICE_ID}/series?metric=${metric}&from=${Date.parse("2026-09-15T02:30:00Z") / 1000}&to=${nowMs / 1000}`;
      const rawResult = await handleRequest(new Request(`${path}&resolution=raw`), runtimeEnv);
      expect(await rawResult.json()).toMatchObject({ points: [{ value: raw }, expect.anything()] });
      const hourlyResult = await handleRequest(new Request(`${path}&resolution=1h`), runtimeEnv);
      expect(await hourlyResult.json()).toMatchObject({ points: [{ avg, n: 2 }] });
    }
  });

  it("prevents signed HTTP ingestion into the Worker-managed device", async () => {
    const response = await handleRequest(new Request("https://example.com/api/v1/ingest", {
      method: "POST", headers: { "X-Device-Id": AQI_IN_DEVICE_ID, "X-Signature": "anything" },
      body: JSON.stringify({ pm25_ugm3: 99 }),
    }), runtimeEnv);
    expect(response.status).toBe(401);
  });

  it("dispatches the ten-minute cron even if delivery is late, and ignores upstream AQI", async () => {
    const token = `e30.${btoa(JSON.stringify({ exp: nowMs / 1000 + 3600 })).replace(/=/g, "")}.fixture`;
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ siteStore: { token2: token } })))
      .mockResolvedValueOnce(Response.json({ status: "success", data: [{
        uid: MUTHANALLUR.uid, location_slug: MUTHANALLUR.slug,
        isOnline: true, updatedAt: reading().observedAt,
        iaqi: { pm25: 3, aqi: 499, "AQI-IN": 500 },
      }] }));
    vi.stubGlobal("fetch", request);
    vi.spyOn(Date, "now").mockReturnValue(nowMs + 61_000);
    await runScheduledJobs(runtimeEnv, nowMs + 61_000, AQI_IN_CRON);
    expect(request).toHaveBeenCalledTimes(2);
    expect(await env.DB.prepare("SELECT aqi_us FROM samples_raw").first("aqi_us")).toBe(12);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM samples_hourly").first("n")).toBe(0);
  });

  it("does not poll on the existing five-minute maintenance cron", async () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    await runScheduledJobs(runtimeEnv, nowMs, "*/5 * * * *");
    expect(request).not.toHaveBeenCalled();
  });
});
