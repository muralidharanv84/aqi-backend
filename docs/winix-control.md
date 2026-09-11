# Winix Control Automation

This document explains how the Winix automation works end-to-end in Cloudflare Workers, with extra detail on auth and DB state logging.

## Files

- `/Users/murali/code/aqi-backend/src/cron/winixControl.ts`
- `/Users/murali/code/aqi-backend/src/winix/client.ts`
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

Winix uses AWS Cognito and SRP. The implementation comes from `winix-api@2.0.2`,
adapted in `src/winix/client.ts`. Wrangler aliases the AWS clients to their ESM
entrypoints so the bundle consistently uses the browser/fetch implementations.
Keep these aliases when updating dependencies, and verify the bundled Worker.

### Why this code looks complex

SRP auth is a challenge/response protocol with large-integer math and multiple
derived keys. Winix rotated to a public Cognito client in April 2026, which does
not use `SECRET_HASH`. The retired client fails with "User pool client does not
exist." Refresh and full-login fallback are both required for old cached tokens
and invalidated sessions.

### Login (`loginWithSrp`)

1. Generate ephemeral SRP values `a` and `A`.
2. Call Cognito `InitiateAuth` with `USER_SRP_AUTH`.
3. Parse `PASSWORD_VERIFIER` challenge (`SRP_B`, `SALT`, `SECRET_BLOCK`, `USER_ID_FOR_SRP`).
4. Derive password key (HKDF over SRP shared secret).
5. Sign challenge payload and call `RespondToAuthChallenge`.
6. Extract access, ID, and refresh tokens and JWT `sub` (`userId`). The ID token
   is needed for the identity-pool lookup, and is cached alongside the access token.

### Refresh (`refreshAccessToken`)

1. Call Cognito `InitiateAuth` with `REFRESH_TOKEN`.
2. Keep existing refresh token, replace access token and expiry.

The public client sends only the refresh token, without a client secret hash.

### Runtime token strategy (`resolveWinixAuthState`)

1. Use stored tokens if an ID token exists and the access token has more than
   10 minutes remaining. Database expiry is epoch seconds; the API library uses
   milliseconds, so the adapter converts in both directions.
2. Else try refresh.
3. If refresh fails, do full SRP login.

This fallback is intentional because Winix app logins can invalidate existing sessions.

## Device Session Flow

After auth (`winix-api`, through `src/winix/client.ts`):

1. Build Winix UUID from JWT `sub`.
2. Resolve the Cognito identity ID using the ID token.
3. `/registerUser`, including the identity ID.
4. `/init`
5. `/checkAccessToken`, including the identity ID.
6. `/getDeviceInfoList`
7. Select all devices (or the configured subset via `WINIX_TARGET_DEVICE_IDS`) and control each.

Mobile requests and responses use the API library's AES-encrypted octet-stream
protocol. Each control cycle creates its own device client with the resolved
identity ID; mutable account session state is not shared between Worker requests.

Device I/O (`winix-api`):

- Read state: `GET /common/event/sttus/devices/{deviceId}`
- Write attributes: `GET /common/control/devices/{deviceId}/{identityId}/{attribute}:{value}`
- Device errors inside an HTTP 200 response (such as `device not connected`)
  reject the command and are recorded as control failures.

## Persistence Model

### `winix_auth_state` (single-row cache, `id=1`)

- `user_id`
- `access_token`
- `id_token` (nullable for legacy rows; refreshed automatically)
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

1. Repeated `error` rows with authentication errors:
   - verify `WINIX_USERNAME` and `WINIX_PASSWORD` secrets
   - ensure username casing exactly matches Winix login
   - "User pool client does not exist" indicates a retired API client; updating
     the password alone will not fix it
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
