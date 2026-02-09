import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { runScheduledJobs } from "../src/index";
import type { Env } from "../src/env";
import { insertDevice, insertSample, resetDb } from "./utils/db";

type HourlyRow = {
  hour_ts: number;
  pm25_avg: number | null;
  n: number;
};

describe("scheduled jobs", () => {
  beforeEach(async () => {
    await resetDb(env.DB);
  });

  it("runs hourly aggregation while winix control is disabled", async () => {
    const runtimeEnv: Env = {
      DB: env.DB,
      WINIX_CONTROL_ENABLED: "false",
      WINIX_MONITOR_DEVICE_ID: "monitor-1",
    };

    const deviceId = "device-hourly";
    await insertDevice(env.DB, deviceId, "secret", "UTC");

    const nowMs = Date.UTC(2024, 0, 1, 10, 5, 0);
    await insertSample(env.DB, deviceId, Date.UTC(2024, 0, 1, 9, 10, 0) / 1000, {
      pm25_ugm3: 10,
    });
    await insertSample(env.DB, deviceId, Date.UTC(2024, 0, 1, 9, 40, 0) / 1000, {
      pm25_ugm3: 20,
    });

    await runScheduledJobs(runtimeEnv, nowMs);

    const row = await env.DB
      .prepare(
        "SELECT hour_ts, pm25_avg, n FROM samples_hourly WHERE device_id = ?",
      )
      .bind(deviceId)
      .first<HourlyRow>();

    expect(row?.hour_ts).toBe(Date.UTC(2024, 0, 1, 9, 0, 0) / 1000);
    expect(row?.pm25_avg).toBe(15);
    expect(row?.n).toBe(2);
  });
});
