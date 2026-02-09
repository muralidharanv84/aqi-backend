# Winix Control Automation

This document explains how the Winix automation works end-to-end in Cloudflare Workers, with extra detail on auth and DB state logging.

## Files

- `/Users/murali/code/aqi-backend/src/cron/winixControl.ts`
- `/Users/murali/code/winix-control-sdk/src/auth.ts`
- `/Users/murali/code/winix-control-sdk/src/account.ts`
- `/Users/murali/code/winix-control-sdk/src/device.ts`
- `/Users/murali/code/aqi-backend/src/index.ts`
- `/Users/murali/code/aqi-backend/db/schema.sql`

## Scheduler And Scope

The Worker cron runs every 5 minutes (`*/5 * * * *`). On each tick, `runScheduledJobs()` starts:

1. `aggregateCompletedHours()` (existing AQI rollup)
2. `runWinixControlLoop()` (Winix fan automation)
3. `enforceWinixControlLogRetention()` (delete Winix log rows older than 30 days)

Only the Winix loop writes to the Winix tables.

## Control Logic

`runWinixControlLoop()` performs one full control cycle:

1. Load runtime config from env.
2. Read PM2.5 window from `samples_raw` for the configured monitor over the previous 5 minutes.
3. Reject stale windows when either:
   - `sample_count < WINIX_MIN_SAMPLES_5M`
   - latest sample age exceeds `WINIX_MAX_SAMPLE_AGE_SECONDS`
4. Compute target speed (in `/Users/murali/code/aqi-backend/src/cron/winixControl.ts`):
   - Base mapping: `<10 -> low`, `<20 -> medium`, `<=30 -> high`, `>30 -> turbo`
   - Hysteresis deadband around 10, 20, 30 via `WINIX_DEADBAND_UGM3`
   - Dwell lock (`WINIX_MIN_DWELL_MINUTES`) to suppress rapid toggles
5. Resolve auth/session and target Winix devices.
   - default: all devices returned by Winix account APIs
   - optional filter: `WINIX_TARGET_DEVICE_IDS` (comma-separated list)
6. Enforce purifier state on each target device in this order:
   - power on
   - manual mode
   - target airflow
7. Append one control run record to `winix_control_log`.
8. Persist auth cache in `winix_auth_state`.

When data is stale or any API step fails, the loop keeps the previous effective speed and appends a log row with `run_status` set to `skipped_stale` or `error`.

## Auth Flow (Detailed)

Winix uses AWS Cognito and SRP. The implementation in `winix-control-sdk` (`/Users/murali/code/winix-control-sdk/src/auth.ts`) is Worker-safe (Web Crypto + `fetch`, no Node runtime assumptions).

### Why this code looks complex

SRP auth is a challenge/response protocol with large-integer math and multiple derived keys. Cognito also requires request-specific `SECRET_HASH` values, and Winix sessions may invalidate unexpectedly, so refresh and full-login fallback are both required.

### Login (`loginWithSrp`)

1. Generate ephemeral SRP values `a` and `A`.
2. Call Cognito `InitiateAuth` with `USER_SRP_AUTH`.
3. Parse `PASSWORD_VERIFIER` challenge (`SRP_B`, `SALT`, `SECRET_BLOCK`, `USER_ID_FOR_SRP`).
4. Derive password key (HKDF over SRP shared secret).
5. Sign challenge payload and call `RespondToAuthChallenge`.
6. Extract tokens and JWT `sub` (`userId`) for downstream calls.

### Refresh (`refreshAccessToken`)

1. Call Cognito `InitiateAuth` with `REFRESH_TOKEN`.
2. Keep existing refresh token, replace access token and expiry.

Important nuance: refresh `SECRET_HASH` is computed with the Cognito `userId` (`sub`), not the email-style login username.

### Runtime token strategy (`resolveWinixAuthState`)

1. Use stored token if still fresh (`WINIX_REFRESH_MARGIN_SECONDS` safety margin).
2. Else try refresh.
3. If refresh fails, do full SRP login.

This fallback is intentional because Winix app logins can invalidate existing sessions.

## Device Session Flow

After auth (`/Users/murali/code/winix-control-sdk/src/account.ts`):

1. Build Winix UUID from JWT `sub`.
2. `/registerUser`
3. `/checkAccessToken`
4. `/getDeviceInfoList`
5. Select all devices (or the configured subset via `WINIX_TARGET_DEVICE_IDS`) and control each.

Device I/O (`/Users/murali/code/winix-control-sdk/src/device.ts`):

- Read state: `GET /common/event/sttus/devices/{deviceId}`
- Write attributes: `GET /common/control/devices/{deviceId}/A211/{attribute}:{value}`

## Persistence Model

### `winix_auth_state` (single-row cache, `id=1`)

- `user_id`
- `access_token`
- `refresh_token`
- `access_expires_at`
- `updated_ts`

### `winix_control_log` (append-only run history)

Each control loop run inserts one row:

- Run metadata: `run_ts`, `run_status`, `monitor_device_id`, `winix_device_id`
- PM context: `pm25_avg`, `sample_count`, `last_sample_ts`
- Decision context: `previous_speed`, `target_speed`, `effective_speed`, `speed_changed`, `effective_change_ts`
- Reliability context: `error_streak`, `error_message`, `created_ts`

`run_status` values:

- `success`: normal control path completed
- `skipped_stale`: insufficient/fresh data was not available
- `error`: auth/device/control failure

`winix_device_id` stores the controlled target IDs as a comma-separated string for each run.

### Retention policy

`winix_control_log` is pruned to a rolling 30-day window. Retention runs on every scheduled tick, independent of whether Winix control is enabled.

## Useful Queries

Latest control outcome:

```sql
SELECT *
FROM winix_control_log
ORDER BY id DESC
LIMIT 1;
```

Recent speed changes only:

```sql
SELECT run_ts, previous_speed, target_speed, effective_speed
FROM winix_control_log
WHERE speed_changed = 1
ORDER BY id DESC
LIMIT 50;
```

## Troubleshooting

1. Repeated `error` rows with secret-hash errors:
   - verify `WINIX_USERNAME` and `WINIX_PASSWORD` secrets
   - ensure username casing exactly matches Winix login
2. Frequent `skipped_stale` rows:
   - verify monitor `device_id` and ingestion cadence
   - inspect `WINIX_MIN_SAMPLES_5M` and `WINIX_MAX_SAMPLE_AGE_SECONDS`
3. No device control even with success auth:
   - if `WINIX_TARGET_DEVICE_IDS` is set, verify all configured IDs exist in account device list
   - otherwise verify Winix account device list contains the expected purifiers
4. Unexpected fan changes:
   - verify deadband/dwell env vars
   - inspect `speed_changed` and `effective_change_ts` in `winix_control_log`

## Intentional Defaults

- Device selection: all Winix devices returned by account API, unless `WINIX_TARGET_DEVICE_IDS` limits the set.
- Safety on failure: hold previous effective speed.
- Manual app overrides: automation re-applies computed speed on next cycle.
