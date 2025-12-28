import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { aggregateCompletedHours } from "../src/cron/aggregate";
import { insertDevice, insertSample, resetDb } from "./utils/db";

type HourlyRow = {
  hour_ts: number;
  pm25_avg: number | null;
  pm25_min: number | null;
  pm25_max: number | null;
  n: number;
};

describe("hourly aggregation", () => {
  beforeEach(async () => {
    await resetDb(env.DB);
  });

  it("aggregates last complete hour using device timezone", async () => {
    const deviceId = "device-ist";
    await insertDevice(env.DB, deviceId, "secret", "Asia/Kolkata");

    const nowMs = Date.UTC(2024, 0, 1, 10, 5, 0);
    const inWindow1 = Date.UTC(2024, 0, 1, 8, 40, 0) / 1000;
    const inWindow2 = Date.UTC(2024, 0, 1, 9, 10, 0) / 1000;
    const outWindow = Date.UTC(2024, 0, 1, 9, 40, 0) / 1000;

    await insertSample(env.DB, deviceId, inWindow1, { pm25_ugm3: 10 });
    await insertSample(env.DB, deviceId, inWindow2, { pm25_ugm3: 20 });
    await insertSample(env.DB, deviceId, outWindow, { pm25_ugm3: 30 });

    await aggregateCompletedHours(env, nowMs);

    const row = await env.DB
      .prepare(
        "SELECT hour_ts, pm25_avg, pm25_min, pm25_max, n FROM samples_hourly WHERE device_id = ?",
      )
      .bind(deviceId)
      .first<HourlyRow>();

    expect(row?.hour_ts).toBe(Date.UTC(2024, 0, 1, 8, 30, 0) / 1000);
    expect(row?.pm25_avg).toBe(15);
    expect(row?.pm25_min).toBe(10);
    expect(row?.pm25_max).toBe(20);
    expect(row?.n).toBe(2);
  });

  it("uses UTC hour boundaries for UTC timezone", async () => {
    const deviceId = "device-utc";
    await insertDevice(env.DB, deviceId, "secret", "UTC");

    const nowMs = Date.UTC(2024, 0, 1, 10, 5, 0);
    await insertSample(env.DB, deviceId, Date.UTC(2024, 0, 1, 9, 10, 0) / 1000, {
      pm25_ugm3: 12,
    });
    await insertSample(env.DB, deviceId, Date.UTC(2024, 0, 1, 9, 50, 0) / 1000, {
      pm25_ugm3: 18,
    });

    await aggregateCompletedHours(env, nowMs);

    const row = await env.DB
      .prepare("SELECT hour_ts, pm25_avg, n FROM samples_hourly WHERE device_id = ?")
      .bind(deviceId)
      .first<HourlyRow>();

    expect(row?.hour_ts).toBe(Date.UTC(2024, 0, 1, 9, 0, 0) / 1000);
    expect(row?.pm25_avg).toBe(15);
    expect(row?.n).toBe(2);
  });

  it("skips aggregation when no samples exist in the last hour", async () => {
    const deviceId = "device-empty";
    await insertDevice(env.DB, deviceId, "secret", "UTC");

    const nowMs = Date.UTC(2024, 0, 1, 10, 5, 0);
    await insertSample(env.DB, deviceId, Date.UTC(2024, 0, 1, 7, 0, 0) / 1000, {
      pm25_ugm3: 5,
    });

    await aggregateCompletedHours(env, nowMs);

    const row = await env.DB
      .prepare("SELECT hour_ts FROM samples_hourly WHERE device_id = ?")
      .bind(deviceId)
      .first<HourlyRow>();

    expect(row).toBeNull();
  });
});
