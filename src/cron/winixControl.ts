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

type ControlLogRow = {
  effective_speed: string | null;
  effective_change_ts: number | null;
  error_streak: number | null;
};

type PreviousControlState = {
  speed: FanSpeed | null;
  changeTs: number | null;
  errorStreak: number;
};

export interface WinixControlConfig {
  enabled: boolean;
  dryRun: boolean;
  monitorDeviceId: string;
  targetDeviceIds: string[];
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

const GET_LATEST_CONTROL_LOG_SQL = `
  SELECT
    effective_speed,
    effective_change_ts,
    error_streak
  FROM winix_control_log
  ORDER BY id DESC
  LIMIT 1
`;

const INSERT_CONTROL_LOG_SQL = `
  INSERT INTO winix_control_log (
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
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const DELETE_CONTROL_LOG_OLDER_THAN_SQL = `
  DELETE FROM winix_control_log
  WHERE run_ts < ?
`;

export const WINIX_CONTROL_LOG_RETENTION_DAYS = 30;
const SECONDS_PER_DAY = 24 * 60 * 60;

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

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  const parsed = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return [...new Set(parsed)];
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
    targetDeviceIds: parseCsv(env.WINIX_TARGET_DEVICE_IDS),
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
  // Baseline mapping requested by user.
  if (pm25Avg < 10) return "low";
  if (pm25Avg < 20) return "medium";
  if (pm25Avg <= 30) return "high";
  return "turbo";
}

export function chooseHysteresisSpeed(
  pm25Avg: number,
  previousSpeed: FanSpeed | null,
  deadbandUgm3: number,
): FanSpeed {
  if (!previousSpeed) return mapPm25ToSpeed(pm25Avg);

  // Deadband strategy:
  // - move up only after crossing threshold + deadband
  // - move down only after crossing threshold - deadband
  const upToMedium = 10 + deadbandUgm3;
  const upToHigh = 20 + deadbandUgm3;
  const upToTurbo = 30 + deadbandUgm3;

  const downToLow = 10 - deadbandUgm3;
  const downToMedium = 20 - deadbandUgm3;
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
  // Minimum hold time to avoid frequent speed toggles around thresholds.
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
  // Reject stale windows to avoid driving purifier with missing/old monitor data.
  if (sampleCount < minSamples) return true;
  if (lastSampleTs === null) return true;
  if (nowTs - lastSampleTs > maxAgeSeconds) return true;
  return false;
}

export async function enforceWinixControlLogRetention(
  env: Env,
  nowMs: number = Date.now(),
): Promise<void> {
  // Keep a rolling 30-day history in the append-only log table.
  const nowTs = Math.floor(nowMs / 1000);
  const cutoffTs = nowTs - WINIX_CONTROL_LOG_RETENTION_DAYS * SECONDS_PER_DAY;
  await env.DB.prepare(DELETE_CONTROL_LOG_OLDER_THAN_SQL).bind(cutoffTs).run();
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

async function readPreviousControlState(env: Env): Promise<PreviousControlState> {
  const latest = await env.DB.prepare(GET_LATEST_CONTROL_LOG_SQL).first<ControlLogRow>();
  if (latest) {
    return {
      speed: parseFanSpeed(latest.effective_speed),
      changeTs: latest.effective_change_ts ?? null,
      errorStreak: latest.error_streak ?? 0,
    };
  }
  return { speed: null, changeTs: null, errorStreak: 0 };
}

async function appendControlLog(
  env: Env,
  row: {
    runTs: number;
    runStatus: "success" | "skipped_stale" | "error";
    monitorDeviceId: string | null;
    winixDeviceId: string | null;
    pm25Avg: number | null;
    sampleCount: number | null;
    lastSampleTs: number | null;
    previousSpeed: FanSpeed | null;
    targetSpeed: FanSpeed | null;
    effectiveSpeed: FanSpeed | null;
    speedChanged: boolean;
    effectiveChangeTs: number | null;
    errorStreak: number;
    errorMessage: string | null;
    nowTs: number;
  },
): Promise<void> {
  await env.DB
    .prepare(INSERT_CONTROL_LOG_SQL)
    .bind(
      row.runTs,
      row.runStatus,
      row.monitorDeviceId,
      row.winixDeviceId,
      row.pm25Avg,
      row.sampleCount,
      row.lastSampleTs,
      row.previousSpeed,
      row.targetSpeed,
      row.effectiveSpeed,
      row.speedChanged ? 1 : 0,
      row.effectiveChangeTs,
      row.errorStreak,
      row.errorMessage,
      row.nowTs,
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

function resolveTargetDevices(
  configTargetIds: string[],
  session: WinixResolvedSession,
): { deviceIds: string[]; missingIds: string[] } {
  const allDeviceIds = session.devices
    .map((device) => device.deviceId)
    .filter((deviceId) => deviceId.length > 0);

  if (configTargetIds.length === 0) {
    return { deviceIds: allDeviceIds, missingIds: [] };
  }

  const available = new Set(allDeviceIds);
  const missingIds = configTargetIds.filter((deviceId) => !available.has(deviceId));
  const selectedIds = configTargetIds.filter((deviceId) => available.has(deviceId));
  return { deviceIds: selectedIds, missingIds };
}

function joinDeviceIds(deviceIds: string[]): string | null {
  if (deviceIds.length === 0) return null;
  return deviceIds.join(",");
}

export const defaultWinixControlClient: WinixControlClient = {
  async resolveSession(
    username: string,
    password: string,
    storedAuth: StoredWinixAuthState | null,
    nowSec: number,
  ): Promise<WinixResolvedSession> {
    // First attempt with stored auth (or refresh), then force full login if device fetch fails.
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
  // Single 5-minute control cycle:
  // 1) read PM2.5 window
  // 2) calculate target with hysteresis + dwell
  // 3) authenticate and select target Winix devices
  // 4) enforce on/manual/airflow on each device (unless dry-run)
  // 5) persist control/auth state
  const config = resolveWinixControlConfig(env);
  if (!config.enabled) return { status: "disabled" };

  const nowTs = Math.floor(nowMs / 1000);
  const previousState = await readPreviousControlState(env);
  const previousSpeed = previousState.speed;
  const previousChangeTs = previousState.changeTs;
  const previousErrorStreak = previousState.errorStreak;

  const recordError = async (
    reason: string,
    pm25Avg: number | null,
    lastSampleTs: number | null,
    sampleCount: number | null,
    winixDeviceIds: string[] | null = null,
  ): Promise<WinixControlRunResult> => {
    await appendControlLog(env, {
      runTs: nowTs,
      runStatus: "error",
      monitorDeviceId: config.monitorDeviceId || null,
      winixDeviceId: joinDeviceIds(winixDeviceIds ?? []),
      pm25Avg,
      sampleCount,
      lastSampleTs,
      previousSpeed,
      targetSpeed: null,
      effectiveSpeed: previousSpeed,
      speedChanged: false,
      effectiveChangeTs: previousChangeTs,
      errorStreak: previousErrorStreak + 1,
      errorMessage: reason,
      nowTs,
    });
    return { status: "error", reason };
  };

  if (!config.monitorDeviceId) {
    return recordError("WINIX_MONITOR_DEVICE_ID is not configured", null, null, null);
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
    await appendControlLog(env, {
      runTs: nowTs,
      runStatus: "skipped_stale",
      monitorDeviceId: config.monitorDeviceId,
      winixDeviceId: null,
      pm25Avg: window.pm25Avg,
      sampleCount: window.sampleCount,
      lastSampleTs: window.lastSampleTs,
      previousSpeed,
      targetSpeed: null,
      effectiveSpeed: previousSpeed,
      speedChanged: false,
      effectiveChangeTs: previousChangeTs,
      errorStreak: previousErrorStreak + 1,
      errorMessage: reason,
      nowTs,
    });
    return { status: "skipped_stale", reason };
  }

  const username = env.WINIX_USERNAME?.trim() ?? "";
  const password = env.WINIX_PASSWORD ?? "";
  if (!username || !password) {
    return recordError(
      "Winix credentials are not configured",
      window.pm25Avg,
      window.lastSampleTs,
      window.sampleCount,
    );
  }

  let targetDeviceIds: string[] | null = null;
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

    const targetSelection = resolveTargetDevices(config.targetDeviceIds, session);
    if (targetSelection.deviceIds.length === 0) {
      throw new Error("No Winix devices were returned by the account");
    }
    if (targetSelection.missingIds.length > 0) {
      throw new Error(
        `Configured WINIX_TARGET_DEVICE_IDS were not found: ${targetSelection.missingIds.join(",")}`,
      );
    }

    targetDeviceIds = targetSelection.deviceIds;
    const failedDeviceReasons: string[] = [];

    if (!config.dryRun) {
      for (const deviceId of targetDeviceIds) {
        try {
          const currentState = await client.getDeviceState(deviceId);
          if (currentState.power !== "on") {
            await client.setPowerOn(deviceId);
          }
          if (currentState.mode !== "manual") {
            await client.setModeManual(deviceId);
          }
          if (currentState.airflow !== targetSpeed) {
            await client.setAirflow(deviceId, targetSpeed);
          }
        } catch (error) {
          failedDeviceReasons.push(
            `${deviceId}:${truncateError(error)}`,
          );
        }
      }
    }

    if (failedDeviceReasons.length > 0) {
      throw new Error(
        `Failed to control one or more Winix devices (${failedDeviceReasons.length}/${targetDeviceIds.length}): ${failedDeviceReasons.join(" | ")}`,
      );
    }

    const speedChanged = previousSpeed !== targetSpeed;
    const effectiveChangeTs = speedChanged ? nowTs : previousChangeTs ?? nowTs;
    await appendControlLog(env, {
      runTs: nowTs,
      runStatus: "success",
      monitorDeviceId: config.monitorDeviceId,
      winixDeviceId: joinDeviceIds(targetDeviceIds),
      pm25Avg: window.pm25Avg,
      sampleCount: window.sampleCount,
      lastSampleTs: window.lastSampleTs,
      previousSpeed,
      targetSpeed,
      effectiveSpeed: targetSpeed,
      speedChanged,
      effectiveChangeTs,
      errorStreak: 0,
      errorMessage: null,
      nowTs,
    });

    return { status: "success", targetSpeed, pm25Avg: window.pm25Avg };
  } catch (error) {
    return recordError(
      truncateError(error),
      window.pm25Avg,
      window.lastSampleTs,
      window.sampleCount,
      targetDeviceIds,
    );
  }
}
