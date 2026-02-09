import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { runWinixControlLoop } from "../src/cron/winixControl";
import {
  applyDwell,
  chooseHysteresisSpeed,
  isWindowStale,
  mapPm25ToSpeed,
} from "../src/cron/winixControl";
import type { Env } from "../src/env";
import type { FanSpeed } from "winix-control-sdk";
import { insertDevice, insertSample, resetDb } from "./utils/db";

type ControlStateRow = {
  run_status: string;
  winix_device_id: string | null;
  previous_speed: string | null;
  target_speed: string | null;
  effective_speed: string | null;
  speed_changed: number;
  effective_change_ts: number | null;
  pm25_avg: number | null;
  sample_count: number | null;
  last_sample_ts: number | null;
  error_streak: number;
  error_message: string | null;
};

type AuthStateRow = {
  user_id: string;
  access_token: string;
  refresh_token: string;
  access_expires_at: number;
};

function buildControlEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: env.DB,
    WINIX_USERNAME: "user@example.com",
    WINIX_PASSWORD: "password",
    WINIX_MONITOR_DEVICE_ID: "monitor-1",
    WINIX_CONTROL_ENABLED: "true",
    WINIX_DEADBAND_UGM3: "2",
    WINIX_MIN_DWELL_MINUTES: "10",
    WINIX_MIN_SAMPLES_5M: "3",
    WINIX_MAX_SAMPLE_AGE_SECONDS: "360",
    WINIX_DRY_RUN: "false",
    ...overrides,
  };
}

describe("winix control logic helpers", () => {
  it("maps PM2.5 boundaries to expected fan speeds", () => {
    expect(mapPm25ToSpeed(9.9)).toBe("low");
    expect(mapPm25ToSpeed(10.0)).toBe("medium");
    expect(mapPm25ToSpeed(19.9)).toBe("medium");
    expect(mapPm25ToSpeed(20.0)).toBe("high");
    expect(mapPm25ToSpeed(30.0)).toBe("high");
    expect(mapPm25ToSpeed(30.1)).toBe("turbo");
  });

  it("applies hysteresis deadband around thresholds", () => {
    expect(chooseHysteresisSpeed(22, "medium", 2)).toBe("high");
    expect(chooseHysteresisSpeed(21.9, "medium", 2)).toBe("medium");
    expect(chooseHysteresisSpeed(17.9, "high", 2)).toBe("medium");
    expect(chooseHysteresisSpeed(28, "turbo", 2)).toBe("high");
    expect(chooseHysteresisSpeed(7.9, "medium", 2)).toBe("low");
  });

  it("enforces dwell time to avoid rapid fan flips", () => {
    expect(applyDwell("high", "medium", 1_000, 1_599, 600)).toBe("medium");
    expect(applyDwell("high", "medium", 1_000, 1_600, 600)).toBe("high");
  });

  it("flags stale PM2.5 windows correctly", () => {
    expect(isWindowStale(2, 1_000, 1_100, 3, 360)).toBe(true);
    expect(isWindowStale(3, null, 1_100, 3, 360)).toBe(true);
    expect(isWindowStale(3, 600, 1_100, 3, 360)).toBe(true);
    expect(isWindowStale(3, 900, 1_100, 3, 360)).toBe(false);
  });
});

describe("runWinixControlLoop", () => {
  beforeEach(async () => {
    await resetDb(env.DB);
  });

  it("skips control and records stale state when samples are insufficient", async () => {
    const controlEnv = buildControlEnv();
    const nowTs = 10_000;
    await insertDevice(controlEnv.DB, "monitor-1", "secret");
    await insertSample(controlEnv.DB, "monitor-1", nowTs - 60, { pm25_ugm3: 20 });

    const mockClient = {
      resolveSession: vi.fn(),
      getDeviceState: vi.fn(),
      setPowerOn: vi.fn(),
      setModeManual: vi.fn(),
      setAirflow: vi.fn(),
    };

    const result = await runWinixControlLoop(
      controlEnv,
      nowTs * 1000,
      mockClient,
    );
    expect(result.status).toBe("skipped_stale");
    expect(mockClient.resolveSession).toHaveBeenCalledTimes(0);

    const state = await controlEnv.DB
      .prepare(
        "SELECT * FROM winix_control_log ORDER BY id DESC LIMIT 1",
      )
      .first<ControlStateRow>();

    expect(state?.error_streak).toBe(1);
    expect(state?.run_status).toBe("skipped_stale");
    expect(state?.effective_speed).toBeNull();
    expect(state?.target_speed).toBeNull();
    expect(state?.error_message?.toLowerCase()).toContain("stale");
  });

  it("authenticates, controls speed, and writes auth/control state", async () => {
    const controlEnv = buildControlEnv();
    const nowTs = 20_000;
    await insertDevice(controlEnv.DB, "monitor-1", "secret");
    await insertSample(controlEnv.DB, "monitor-1", nowTs - 250, { pm25_ugm3: 31 });
    await insertSample(controlEnv.DB, "monitor-1", nowTs - 180, { pm25_ugm3: 32 });
    await insertSample(controlEnv.DB, "monitor-1", nowTs - 60, { pm25_ugm3: 33 });

    const calls: Array<{ method: string; speed?: FanSpeed }> = [];
    const mockClient = {
      resolveSession: vi.fn().mockResolvedValue({
        auth: {
          userId: "u1",
          accessToken: "a1",
          refreshToken: "r1",
          accessExpiresAt: nowTs + 3600,
        },
        devices: [{ deviceId: "device-1", alias: "Living Room", model: "T800" }],
      }),
      getDeviceState: vi.fn().mockResolvedValue({
        power: "off",
        mode: "auto",
        airflow: "low",
      }),
      setPowerOn: vi.fn().mockImplementation(async () => {
        calls.push({ method: "power" });
      }),
      setModeManual: vi.fn().mockImplementation(async () => {
        calls.push({ method: "manual" });
      }),
      setAirflow: vi.fn().mockImplementation(async (_deviceId: string, speed: FanSpeed) => {
        calls.push({ method: "airflow", speed });
      }),
    };

    const result = await runWinixControlLoop(
      controlEnv,
      nowTs * 1000,
      mockClient,
    );

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.targetSpeed).toBe("turbo");
    }

    expect(mockClient.resolveSession).toHaveBeenCalledTimes(1);
    expect(mockClient.getDeviceState).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([
      { method: "power" },
      { method: "manual" },
      { method: "airflow", speed: "turbo" },
    ]);

    const controlState = await controlEnv.DB
      .prepare(
        "SELECT * FROM winix_control_log ORDER BY id DESC LIMIT 1",
      )
      .first<ControlStateRow>();
    expect(controlState?.run_status).toBe("success");
    expect(controlState?.winix_device_id).toBe("device-1");
    expect(controlState?.previous_speed).toBeNull();
    expect(controlState?.target_speed).toBe("turbo");
    expect(controlState?.effective_speed).toBe("turbo");
    expect(controlState?.speed_changed).toBe(1);
    expect(controlState?.error_streak).toBe(0);
    expect(controlState?.error_message).toBeNull();
    expect(controlState?.effective_change_ts).toBe(nowTs);
    expect(controlState?.pm25_avg).toBe(32);

    const authState = await controlEnv.DB
      .prepare("SELECT * FROM winix_auth_state WHERE id = 1")
      .first<AuthStateRow>();
    expect(authState?.user_id).toBe("u1");
    expect(authState?.access_token).toBe("a1");
    expect(authState?.refresh_token).toBe("r1");
  });

  it("controls all returned devices in the same cycle", async () => {
    const controlEnv = buildControlEnv();
    const nowTs = 25_000;
    await insertDevice(controlEnv.DB, "monitor-1", "secret");
    await insertSample(controlEnv.DB, "monitor-1", nowTs - 250, { pm25_ugm3: 31 });
    await insertSample(controlEnv.DB, "monitor-1", nowTs - 180, { pm25_ugm3: 32 });
    await insertSample(controlEnv.DB, "monitor-1", nowTs - 60, { pm25_ugm3: 33 });

    const calls: Array<{ deviceId: string; method: string; speed?: FanSpeed }> = [];
    const mockClient = {
      resolveSession: vi.fn().mockResolvedValue({
        auth: {
          userId: "u1",
          accessToken: "a1",
          refreshToken: "r1",
          accessExpiresAt: nowTs + 3600,
        },
        devices: [
          { deviceId: "device-1", alias: "Living Room 1", model: "T800" },
          { deviceId: "device-2", alias: "Living Room 2", model: "T800" },
        ],
      }),
      getDeviceState: vi.fn().mockResolvedValue({
        power: "off",
        mode: "auto",
        airflow: "low",
      }),
      setPowerOn: vi.fn().mockImplementation(async (deviceId: string) => {
        calls.push({ deviceId, method: "power" });
      }),
      setModeManual: vi.fn().mockImplementation(async (deviceId: string) => {
        calls.push({ deviceId, method: "manual" });
      }),
      setAirflow: vi.fn().mockImplementation(async (deviceId: string, speed: FanSpeed) => {
        calls.push({ deviceId, method: "airflow", speed });
      }),
    };

    const result = await runWinixControlLoop(controlEnv, nowTs * 1000, mockClient);
    expect(result.status).toBe("success");
    expect(mockClient.getDeviceState).toHaveBeenCalledTimes(2);
    expect(calls).toEqual([
      { deviceId: "device-1", method: "power" },
      { deviceId: "device-1", method: "manual" },
      { deviceId: "device-1", method: "airflow", speed: "turbo" },
      { deviceId: "device-2", method: "power" },
      { deviceId: "device-2", method: "manual" },
      { deviceId: "device-2", method: "airflow", speed: "turbo" },
    ]);

    const controlState = await controlEnv.DB
      .prepare("SELECT * FROM winix_control_log ORDER BY id DESC LIMIT 1")
      .first<ControlStateRow>();
    expect(controlState?.run_status).toBe("success");
    expect(controlState?.winix_device_id).toBe("device-1,device-2");
  });

  it("limits control to WINIX_TARGET_DEVICE_IDS when configured", async () => {
    const controlEnv = buildControlEnv({ WINIX_TARGET_DEVICE_IDS: "device-2" });
    const nowTs = 26_000;
    await insertDevice(controlEnv.DB, "monitor-1", "secret");
    await insertSample(controlEnv.DB, "monitor-1", nowTs - 250, { pm25_ugm3: 31 });
    await insertSample(controlEnv.DB, "monitor-1", nowTs - 180, { pm25_ugm3: 32 });
    await insertSample(controlEnv.DB, "monitor-1", nowTs - 60, { pm25_ugm3: 33 });

    const calls: Array<{ deviceId: string; method: string }> = [];
    const mockClient = {
      resolveSession: vi.fn().mockResolvedValue({
        auth: {
          userId: "u1",
          accessToken: "a1",
          refreshToken: "r1",
          accessExpiresAt: nowTs + 3600,
        },
        devices: [
          { deviceId: "device-1", alias: "Living Room 1", model: "T800" },
          { deviceId: "device-2", alias: "Living Room 2", model: "T800" },
        ],
      }),
      getDeviceState: vi.fn().mockImplementation(async (deviceId: string) => {
        calls.push({ deviceId, method: "state" });
        return { power: "off", mode: "auto", airflow: "low" as FanSpeed };
      }),
      setPowerOn: vi.fn(),
      setModeManual: vi.fn(),
      setAirflow: vi.fn(),
    };

    const result = await runWinixControlLoop(controlEnv, nowTs * 1000, mockClient);
    expect(result.status).toBe("success");
    expect(calls).toEqual([{ deviceId: "device-2", method: "state" }]);

    const controlState = await controlEnv.DB
      .prepare("SELECT * FROM winix_control_log ORDER BY id DESC LIMIT 1")
      .first<ControlStateRow>();
    expect(controlState?.run_status).toBe("success");
    expect(controlState?.winix_device_id).toBe("device-2");
  });

  it("errors if WINIX_TARGET_DEVICE_IDS contains unknown devices", async () => {
    const controlEnv = buildControlEnv({
      WINIX_TARGET_DEVICE_IDS: "device-1,missing-device",
    });
    const nowTs = 27_000;
    await insertDevice(controlEnv.DB, "monitor-1", "secret");
    await insertSample(controlEnv.DB, "monitor-1", nowTs - 250, { pm25_ugm3: 15 });
    await insertSample(controlEnv.DB, "monitor-1", nowTs - 180, { pm25_ugm3: 16 });
    await insertSample(controlEnv.DB, "monitor-1", nowTs - 60, { pm25_ugm3: 17 });

    const mockClient = {
      resolveSession: vi.fn().mockResolvedValue({
        auth: {
          userId: "u1",
          accessToken: "a1",
          refreshToken: "r1",
          accessExpiresAt: nowTs + 3600,
        },
        devices: [{ deviceId: "device-1", alias: "Living Room 1", model: "T800" }],
      }),
      getDeviceState: vi.fn(),
      setPowerOn: vi.fn(),
      setModeManual: vi.fn(),
      setAirflow: vi.fn(),
    };

    const result = await runWinixControlLoop(controlEnv, nowTs * 1000, mockClient);
    expect(result.status).toBe("error");
    expect(mockClient.getDeviceState).toHaveBeenCalledTimes(0);

    const controlState = await controlEnv.DB
      .prepare("SELECT * FROM winix_control_log ORDER BY id DESC LIMIT 1")
      .first<ControlStateRow>();
    expect(controlState?.run_status).toBe("error");
    expect(controlState?.error_message).toContain("WINIX_TARGET_DEVICE_IDS");
  });

  it("appends log rows across runs and carries prior state forward", async () => {
    const controlEnv = buildControlEnv();
    const nowTs = 30_000;
    await insertDevice(controlEnv.DB, "monitor-1", "secret");

    await insertSample(controlEnv.DB, "monitor-1", nowTs - 250, { pm25_ugm3: 32 });
    await insertSample(controlEnv.DB, "monitor-1", nowTs - 180, { pm25_ugm3: 33 });
    await insertSample(controlEnv.DB, "monitor-1", nowTs - 60, { pm25_ugm3: 34 });

    const mockClient = {
      resolveSession: vi.fn().mockResolvedValue({
        auth: {
          userId: "u1",
          accessToken: "a1",
          refreshToken: "r1",
          accessExpiresAt: nowTs + 3600,
        },
        devices: [{ deviceId: "device-1", alias: "Living Room", model: "T800" }],
      }),
      getDeviceState: vi.fn().mockResolvedValue({
        power: "on",
        mode: "manual",
        airflow: "low",
      }),
      setPowerOn: vi.fn(),
      setModeManual: vi.fn(),
      setAirflow: vi.fn(),
    };

    await runWinixControlLoop(controlEnv, nowTs * 1000, mockClient);

    // Keep PM2.5 high enough to avoid changing speed; this should still write a new log row.
    await insertSample(controlEnv.DB, "monitor-1", nowTs + 60, { pm25_ugm3: 31 });
    await insertSample(controlEnv.DB, "monitor-1", nowTs + 120, { pm25_ugm3: 32 });
    await insertSample(controlEnv.DB, "monitor-1", nowTs + 180, { pm25_ugm3: 33 });

    await runWinixControlLoop(controlEnv, (nowTs + 180) * 1000, mockClient);

    const countRow = await controlEnv.DB
      .prepare("SELECT COUNT(*) AS n FROM winix_control_log")
      .first<{ n: number }>();
    expect(countRow?.n).toBe(2);

    const latest = await controlEnv.DB
      .prepare("SELECT * FROM winix_control_log ORDER BY id DESC LIMIT 1")
      .first<ControlStateRow>();
    expect(latest?.previous_speed).toBe("turbo");
    expect(latest?.target_speed).toBe("turbo");
    expect(latest?.speed_changed).toBe(0);
    expect(latest?.error_streak).toBe(0);
  });

});
