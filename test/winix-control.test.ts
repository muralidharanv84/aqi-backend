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
import type { FanSpeed } from "../src/winix/types";
import { insertDevice, insertSample, resetDb } from "./utils/db";

type ControlStateRow = {
  last_speed: string | null;
  last_change_ts: number | null;
  last_pm25_avg: number | null;
  last_sample_ts: number | null;
  error_streak: number;
  last_error: string | null;
};

type AuthStateRow = {
  user_id: string;
  access_token: string;
  refresh_token: string;
  access_expires_at: number;
};

function buildControlEnv(): Env {
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
      .prepare("SELECT * FROM winix_control_state WHERE id = 1")
      .first<ControlStateRow>();

    expect(state?.error_streak).toBe(1);
    expect(state?.last_speed).toBeNull();
    expect(state?.last_error?.toLowerCase()).toContain("stale");
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
      .prepare("SELECT * FROM winix_control_state WHERE id = 1")
      .first<ControlStateRow>();
    expect(controlState?.last_speed).toBe("turbo");
    expect(controlState?.error_streak).toBe(0);
    expect(controlState?.last_error).toBeNull();
    expect(controlState?.last_change_ts).toBe(nowTs);
    expect(controlState?.last_pm25_avg).toBe(32);

    const authState = await controlEnv.DB
      .prepare("SELECT * FROM winix_auth_state WHERE id = 1")
      .first<AuthStateRow>();
    expect(authState?.user_id).toBe("u1");
    expect(authState?.access_token).toBe("a1");
    expect(authState?.refresh_token).toBe("r1");
  });
});
