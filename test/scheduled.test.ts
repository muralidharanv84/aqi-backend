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
    const nowTs = nowMs / 1000;
    await insertSample(env.DB, deviceId, Date.UTC(2024, 0, 1, 9, 10, 0) / 1000, {
      pm25_ugm3: 10,
    });
    await insertSample(env.DB, deviceId, Date.UTC(2024, 0, 1, 9, 40, 0) / 1000, {
      pm25_ugm3: 20,
    });

    await env.DB
      .prepare(
        `INSERT INTO winix_control_log (
          run_ts,
          run_status,
          monitor_device_id,
          winix_device_id,
          pm25_avg,
          sample_count,
          last_sample_ts,
          previous_speed,
          target_speed,
          effective_speed,
          speed_changed,
          effective_change_ts,
          error_streak,
          error_message,
          created_ts
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        nowTs - 31 * 24 * 60 * 60,
        "success",
        "monitor-1",
        "device-1",
        12,
        3,
        nowTs - 31 * 24 * 60 * 60,
        "low",
        "medium",
        "medium",
        1,
        nowTs - 31 * 24 * 60 * 60,
        0,
        null,
        nowTs - 31 * 24 * 60 * 60,
      )
      .run();
    await env.DB
      .prepare(
        `INSERT INTO winix_control_log (
          run_ts,
          run_status,
          monitor_device_id,
          winix_device_id,
          pm25_avg,
          sample_count,
          last_sample_ts,
          previous_speed,
          target_speed,
          effective_speed,
          speed_changed,
          effective_change_ts,
          error_streak,
          error_message,
          created_ts
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        nowTs - 10 * 24 * 60 * 60,
        "success",
        "monitor-1",
        "device-1",
        14,
        4,
        nowTs - 10 * 24 * 60 * 60,
        "medium",
        "medium",
        "medium",
        0,
        nowTs - 10 * 24 * 60 * 60,
        0,
        null,
        nowTs - 10 * 24 * 60 * 60,
      )
      .run();

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

    const retainedRows = await env.DB
      .prepare("SELECT COUNT(*) AS n FROM winix_control_log")
      .first<{ n: number }>();
    expect(retainedRows?.n).toBe(1);

    const newest = await env.DB
      .prepare(
        "SELECT run_ts FROM winix_control_log ORDER BY id DESC LIMIT 1",
      )
      .first<{ run_ts: number }>();
    expect(newest?.run_ts).toBe(nowTs - 10 * 24 * 60 * 60);
  });
});
