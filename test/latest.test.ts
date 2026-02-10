import { beforeEach, describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import { insertDevice, insertSample, resetDb } from "./utils/db";

type LatestResponse = {
  device_id: string;
  ts: number;
  metrics: Record<string, number>;
  fan_control: {
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
};

describe("latest endpoint", () => {
  beforeEach(async () => {
    await resetDb(env.DB);
  });

  it("rejects non-GET methods", async () => {
    const res = await SELF.fetch("https://example.com/api/v1/devices/device-a/latest", {
      method: "POST",
    });

    expect(res.status).toBe(405);
  });

  it("returns 404 when no samples exist", async () => {
    const deviceId = "device-b";
    await insertDevice(env.DB, deviceId, "secret");

    const res = await SELF.fetch(
      `https://example.com/api/v1/devices/${deviceId}/latest`,
    );

    expect(res.status).toBe(404);
  });

  it("returns the most recent sample with metrics", async () => {
    const deviceId = "device-c";
    await insertDevice(env.DB, deviceId, "secret");

    await insertSample(env.DB, deviceId, 1700000000, { pm25_ugm3: 9.1 });
    await insertSample(env.DB, deviceId, 1700000060, {
      co2_ppm: 701,
      temp_c: 23.4,
    });

    const res = await SELF.fetch(
      `https://example.com/api/v1/devices/${deviceId}/latest`,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as LatestResponse;
    expect(body.device_id).toBe(deviceId);
    expect(body.ts).toBe(1700000060);
    expect(body.metrics).toEqual({ co2_ppm: 701, temp_c: 23.4 });
    expect(body.fan_control).toEqual({
      latest_event: null,
      latest_error: null,
    });
  });

  it("returns latest fan control event and latest fan control error for the monitor", async () => {
    const monitorDeviceId = "device-monitor";
    await insertDevice(env.DB, monitorDeviceId, "secret");
    await insertSample(env.DB, monitorDeviceId, 1700000300, { pm25_ugm3: 18.2 });

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
        1700000100,
        "error",
        monitorDeviceId,
        "purifier-lr",
        40.2,
        5,
        1700000080,
        "high",
        null,
        "high",
        0,
        1700000000,
        2,
        "Auth failed",
        1700000100,
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
        1700000200,
        "success",
        monitorDeviceId,
        "purifier-lr,purifier-br",
        15.4,
        5,
        1700000180,
        "high",
        "medium",
        "medium",
        1,
        1700000200,
        0,
        null,
        1700000200,
      )
      .run();

    const res = await SELF.fetch(
      `https://example.com/api/v1/devices/${monitorDeviceId}/latest`,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as LatestResponse;
    expect(body.fan_control.latest_event).toEqual({
      run_ts: 1700000200,
      status: "success",
      purifier_device_ids: ["purifier-lr", "purifier-br"],
      speed: "medium",
      error_message: null,
    });
    expect(body.fan_control.latest_error).toEqual({
      run_ts: 1700000100,
      status: "error",
      message: "Auth failed",
      error_streak: 2,
    });
  });
});
