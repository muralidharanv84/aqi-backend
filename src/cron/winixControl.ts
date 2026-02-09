import type { Env } from "../env";
import { resolveWinixSession } from "../winix/account";
import { resolveWinixAuthState } from "../winix/auth";
import {
  defaultWinixDeviceClient,
  type WinixDeviceClient,
} from "../winix/device";
import { WINIX_CONTROL_DEFAULTS } from "../winix/constants";
import type {
  FanSpeed,
  StoredWinixAuthState,
  WinixResolvedSession,
} from "../winix/types";

type WindowRow = {
  pm25_avg: number | null;
  n: number | null;
  last_sample_ts: number | null;
};

type AuthRow = {
  user_id: string;
  access_token: string;
  refresh_token: string;
  access_expires_at: number;
};

type ControlStateRow = {
  last_speed: string | null;
  last_change_ts: number | null;
  last_pm25_avg: number | null;
  last_sample_ts: number | null;
  error_streak: number | null;
  last_error: string | null;
};

export interface WinixControlConfig {
  enabled: boolean;
  dryRun: boolean;
  monitorDeviceId: string;
  deadbandUgm3: number;
  minDwellMinutes: number;
  minSamples5m: number;
  maxSampleAgeSeconds: number;
}

export interface WinixControlClient {
  resolveSession(
    username: string,
    password: string,
    storedAuth: StoredWinixAuthState | null,
    nowSec: number,
  ): Promise<WinixResolvedSession>;
  getDeviceState(deviceId: string): ReturnType<WinixDeviceClient["getState"]>;
  setPowerOn(deviceId: string): Promise<void>;
  setModeManual(deviceId: string): Promise<void>;
  setAirflow(deviceId: string, speed: FanSpeed): Promise<void>;
}

export type WinixControlRunResult =
  | { status: "disabled" }
  | { status: "success"; targetSpeed: FanSpeed; pm25Avg: number }
  | { status: "skipped_stale"; reason: string }
  | { status: "error"; reason: string };

const QUERY_WINDOW_SQL = `
  SELECT
    AVG(pm25_ugm3) AS pm25_avg,
    COUNT(pm25_ugm3) AS n,
    MAX(ts) AS last_sample_ts
  FROM samples_raw
  WHERE device_id = ?
    AND ts > ?
    AND ts <= ?
    AND pm25_ugm3 IS NOT NULL
`;

const GET_AUTH_SQL = `
  SELECT user_id, access_token, refresh_token, access_expires_at
  FROM winix_auth_state
  WHERE id = 1
`;

const UPSERT_AUTH_SQL = `
  INSERT INTO winix_auth_state (
    id,
    user_id,
    access_token,
    refresh_token,
    access_expires_at,
    updated_ts
  ) VALUES (1, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    user_id = excluded.user_id,
    access_token = excluded.access_token,
    refresh_token = excluded.refresh_token,
    access_expires_at = excluded.access_expires_at,
    updated_ts = excluded.updated_ts
`;

const GET_CONTROL_STATE_SQL = `
  SELECT
    last_speed,
    last_change_ts,
    last_pm25_avg,
    last_sample_ts,
    error_streak,
    last_error
  FROM winix_control_state
  WHERE id = 1
`;

const UPSERT_CONTROL_STATE_SQL = `
  INSERT INTO winix_control_state (
    id,
    last_speed,
    last_change_ts,
    last_pm25_avg,
    last_sample_ts,
    error_streak,
    last_error,
    updated_ts
  ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    last_speed = excluded.last_speed,
    last_change_ts = excluded.last_change_ts,
    last_pm25_avg = excluded.last_pm25_avg,
    last_sample_ts = excluded.last_sample_ts,
    error_streak = excluded.error_streak,
    last_error = excluded.last_error,
    updated_ts = excluded.updated_ts
`;

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseNumber(
  value: string | undefined,
  fallback: number,
  min: number,
): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) return fallback;
  return parsed;
}

function parseFanSpeed(value: string | null | undefined): FanSpeed | null {
  if (!value) return null;
  if (value === "low" || value === "medium" || value === "high" || value === "turbo") {
    return value;
  }
  return null;
}

function truncateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
}

export function resolveWinixControlConfig(env: Env): WinixControlConfig {
  return {
    enabled: parseBoolean(
      env.WINIX_CONTROL_ENABLED,
      WINIX_CONTROL_DEFAULTS.enabled,
    ),
    dryRun: parseBoolean(env.WINIX_DRY_RUN, WINIX_CONTROL_DEFAULTS.dryRun),
    monitorDeviceId: (env.WINIX_MONITOR_DEVICE_ID ?? "").trim(),
    deadbandUgm3: parseNumber(
      env.WINIX_DEADBAND_UGM3,
      WINIX_CONTROL_DEFAULTS.deadbandUgm3,
      0,
    ),
    minDwellMinutes: parseNumber(
      env.WINIX_MIN_DWELL_MINUTES,
      WINIX_CONTROL_DEFAULTS.minDwellMinutes,
      0,
    ),
    minSamples5m: parseNumber(
      env.WINIX_MIN_SAMPLES_5M,
      WINIX_CONTROL_DEFAULTS.minSamples5m,
      1,
    ),
    maxSampleAgeSeconds: parseNumber(
      env.WINIX_MAX_SAMPLE_AGE_SECONDS,
      WINIX_CONTROL_DEFAULTS.maxSampleAgeSeconds,
      1,
    ),
  };
}

export function mapPm25ToSpeed(pm25Avg: number): FanSpeed {
  if (pm25Avg < 10) return "low";
  if (pm25Avg < 25) return "medium";
  if (pm25Avg <= 30) return "high";
  return "turbo";
}

export function chooseHysteresisSpeed(
  pm25Avg: number,
  previousSpeed: FanSpeed | null,
  deadbandUgm3: number,
): FanSpeed {
  if (!previousSpeed) return mapPm25ToSpeed(pm25Avg);

  const upToMedium = 10 + deadbandUgm3;
  const upToHigh = 25 + deadbandUgm3;
  const upToTurbo = 30 + deadbandUgm3;

  const downToLow = 10 - deadbandUgm3;
  const downToMedium = 25 - deadbandUgm3;
  const downFromTurbo = 30 - deadbandUgm3;

  switch (previousSpeed) {
    case "low":
      if (pm25Avg < upToMedium) return "low";
      if (pm25Avg < upToHigh) return "medium";
      if (pm25Avg <= upToTurbo) return "high";
      return "turbo";
    case "medium":
      if (pm25Avg < downToLow) return "low";
      if (pm25Avg < upToHigh) return "medium";
      if (pm25Avg <= upToTurbo) return "high";
      return "turbo";
    case "high":
      if (pm25Avg < downToLow) return "low";
      if (pm25Avg < downToMedium) return "medium";
      if (pm25Avg <= upToTurbo) return "high";
      return "turbo";
    case "turbo":
      if (pm25Avg < downToLow) return "low";
      if (pm25Avg < downToMedium) return "medium";
      if (pm25Avg <= downFromTurbo) return "high";
      return "turbo";
  }
}

export function applyDwell(
  targetSpeed: FanSpeed,
  previousSpeed: FanSpeed | null,
  previousChangeTs: number | null,
  nowTs: number,
  minDwellSeconds: number,
): FanSpeed {
  if (!previousSpeed || previousChangeTs === null) return targetSpeed;
  if (targetSpeed === previousSpeed) return previousSpeed;

  const elapsed = nowTs - previousChangeTs;
  if (elapsed < minDwellSeconds) return previousSpeed;
  return targetSpeed;
}

export function isWindowStale(
  sampleCount: number,
  lastSampleTs: number | null,
  nowTs: number,
  minSamples: number,
  maxAgeSeconds: number,
): boolean {
  if (sampleCount < minSamples) return true;
  if (lastSampleTs === null) return true;
  if (nowTs - lastSampleTs > maxAgeSeconds) return true;
  return false;
}

async function readStoredAuthState(
  env: Env,
): Promise<StoredWinixAuthState | null> {
  const row = await env.DB.prepare(GET_AUTH_SQL).first<AuthRow>();
  if (!row) return null;
  return {
    userId: row.user_id,
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    accessExpiresAt: row.access_expires_at,
  };
}

async function writeStoredAuthState(
  env: Env,
  auth: StoredWinixAuthState,
  nowTs: number,
): Promise<void> {
  await env.DB
    .prepare(UPSERT_AUTH_SQL)
    .bind(
      auth.userId,
      auth.accessToken,
      auth.refreshToken,
      auth.accessExpiresAt,
      nowTs,
    )
    .run();
}

async function readControlState(env: Env): Promise<ControlStateRow | null> {
  return env.DB.prepare(GET_CONTROL_STATE_SQL).first<ControlStateRow>();
}

async function writeControlState(
  env: Env,
  state: {
    lastSpeed: FanSpeed | null;
    lastChangeTs: number | null;
    lastPm25Avg: number | null;
    lastSampleTs: number | null;
    errorStreak: number;
    lastError: string | null;
    nowTs: number;
  },
): Promise<void> {
  await env.DB
    .prepare(UPSERT_CONTROL_STATE_SQL)
    .bind(
      state.lastSpeed,
      state.lastChangeTs,
      state.lastPm25Avg,
      state.lastSampleTs,
      state.errorStreak,
      state.lastError,
      state.nowTs,
    )
    .run();
}

async function loadPm25Window(
  env: Env,
  monitorDeviceId: string,
  nowTs: number,
): Promise<{ pm25Avg: number | null; sampleCount: number; lastSampleTs: number | null }> {
  const fromTs = nowTs - 5 * 60;
  const row = await env.DB
    .prepare(QUERY_WINDOW_SQL)
    .bind(monitorDeviceId, fromTs, nowTs)
    .first<WindowRow>();

  return {
    pm25Avg: row?.pm25_avg ?? null,
    sampleCount: row?.n ?? 0,
    lastSampleTs: row?.last_sample_ts ?? null,
  };
}

export const defaultWinixControlClient: WinixControlClient = {
  async resolveSession(
    username: string,
    password: string,
    storedAuth: StoredWinixAuthState | null,
    nowSec: number,
  ): Promise<WinixResolvedSession> {
    let auth = await resolveWinixAuthState(
      username,
      password,
      storedAuth,
      nowSec,
    );

    try {
      return await resolveWinixSession(username, auth);
    } catch {
      auth = await resolveWinixAuthState(username, password, null, nowSec);
      return resolveWinixSession(username, auth);
    }
  },
  getDeviceState: defaultWinixDeviceClient.getState,
  setPowerOn: defaultWinixDeviceClient.setPowerOn,
  setModeManual: defaultWinixDeviceClient.setModeManual,
  setAirflow: defaultWinixDeviceClient.setAirflow,
};

export async function runWinixControlLoop(
  env: Env,
  nowMs: number = Date.now(),
  client: WinixControlClient = defaultWinixControlClient,
): Promise<WinixControlRunResult> {
  const config = resolveWinixControlConfig(env);
  if (!config.enabled) return { status: "disabled" };

  const nowTs = Math.floor(nowMs / 1000);
  const previousState = await readControlState(env);
  const previousSpeed = parseFanSpeed(previousState?.last_speed);
  const previousChangeTs = previousState?.last_change_ts ?? null;
  const previousErrorStreak = previousState?.error_streak ?? 0;

  const recordError = async (
    reason: string,
    pm25Avg: number | null,
    lastSampleTs: number | null,
  ): Promise<WinixControlRunResult> => {
    await writeControlState(env, {
      lastSpeed: previousSpeed,
      lastChangeTs: previousChangeTs,
      lastPm25Avg: pm25Avg,
      lastSampleTs,
      errorStreak: previousErrorStreak + 1,
      lastError: reason,
      nowTs,
    });
    return { status: "error", reason };
  };

  if (!config.monitorDeviceId) {
    return recordError("WINIX_MONITOR_DEVICE_ID is not configured", null, null);
  }

  const window = await loadPm25Window(env, config.monitorDeviceId, nowTs);
  const stale = isWindowStale(
    window.sampleCount,
    window.lastSampleTs,
    nowTs,
    config.minSamples5m,
    config.maxSampleAgeSeconds,
  );

  if (stale || window.pm25Avg === null) {
    const reason = `Stale PM2.5 data: samples=${window.sampleCount}, lastSampleTs=${window.lastSampleTs ?? "none"}`;
    await writeControlState(env, {
      lastSpeed: previousSpeed,
      lastChangeTs: previousChangeTs,
      lastPm25Avg: window.pm25Avg,
      lastSampleTs: window.lastSampleTs,
      errorStreak: previousErrorStreak + 1,
      lastError: reason,
      nowTs,
    });
    return { status: "skipped_stale", reason };
  }

  const username = env.WINIX_USERNAME?.trim() ?? "";
  const password = env.WINIX_PASSWORD ?? "";
  if (!username || !password) {
    return recordError("Winix credentials are not configured", window.pm25Avg, window.lastSampleTs);
  }

  try {
    const targetByHysteresis = chooseHysteresisSpeed(
      window.pm25Avg,
      previousSpeed,
      config.deadbandUgm3,
    );
    const minDwellSeconds = Math.floor(config.minDwellMinutes * 60);
    const targetSpeed = applyDwell(
      targetByHysteresis,
      previousSpeed,
      previousChangeTs,
      nowTs,
      minDwellSeconds,
    );

    const storedAuth = await readStoredAuthState(env);
    const session = await client.resolveSession(
      username,
      password,
      storedAuth,
      nowTs,
    );

    await writeStoredAuthState(env, session.auth, nowTs);

    const device = session.devices[0];
    if (!device?.deviceId) {
      throw new Error("No Winix devices were returned by the account");
    }

    if (!config.dryRun) {
      const currentState = await client.getDeviceState(device.deviceId);
      if (currentState.power !== "on") {
        await client.setPowerOn(device.deviceId);
      }
      if (currentState.mode !== "manual") {
        await client.setModeManual(device.deviceId);
      }
      if (currentState.airflow !== targetSpeed) {
        await client.setAirflow(device.deviceId, targetSpeed);
      }
    }

    const changed = previousSpeed !== targetSpeed;
    await writeControlState(env, {
      lastSpeed: targetSpeed,
      lastChangeTs: changed ? nowTs : previousChangeTs ?? nowTs,
      lastPm25Avg: window.pm25Avg,
      lastSampleTs: window.lastSampleTs,
      errorStreak: 0,
      lastError: null,
      nowTs,
    });

    return { status: "success", targetSpeed, pm25Avg: window.pm25Avg };
  } catch (error) {
    return recordError(truncateError(error), window.pm25Avg, window.lastSampleTs);
  }
}
