# Winix Control Automation

This document explains the Winix automation code path and, in particular, the authentication flow used in Cloudflare Workers.

## Files

- `/Users/murali/code/aqi-backend/src/cron/winixControl.ts`
- `/Users/murali/code/aqi-backend/src/winix/auth.ts`
- `/Users/murali/code/aqi-backend/src/winix/account.ts`
- `/Users/murali/code/aqi-backend/src/winix/device.ts`
- `/Users/murali/code/aqi-backend/src/index.ts`

## High-Level Flow

Every 5 minutes (`wrangler.jsonc` cron `*/5 * * * *`), `runScheduledJobs()` runs:

1. `aggregateCompletedHours()` (existing hourly rollup task)
2. `runWinixControlLoop()` (new fan-control task)

`runWinixControlLoop()` does:

1. Load config from env vars.
2. Read 5-minute PM2.5 window for `WINIX_MONITOR_DEVICE_ID`.
3. Reject stale windows (too few samples or old timestamp).
4. Compute target speed with:
   - base mapping: `<10 -> low`, `<20 -> medium`, `<=30 -> high`, `>30 -> turbo`
   - deadband hysteresis (`WINIX_DEADBAND_UGM3`)
   - dwell hold (`WINIX_MIN_DWELL_MINUTES`)
5. Resolve Winix auth (stored token, refresh, then re-login fallback).
6. Resolve account session and get devices (first device is controlled).
7. Enforce purifier state: power on, manual mode, target airflow.
8. Persist status in `winix_control_state` and tokens in `winix_auth_state`.

## Auth Flow (Cognito SRP)

Winix uses Cognito `USER_SRP_AUTH`. This code implements SRP directly in Worker-safe TypeScript because Node-targeted libraries are not reliable in Cloudflare Worker runtime.

### Why not just use winix-api?

`winix-api` works in Node scripts, but in Worker runtime we hit runtime incompatibilities. The current implementation avoids Node-only behavior and uses `fetch` + Web Crypto APIs only.

### Login Steps (`loginWithSrp`)

1. Generate SRP private/public pair (`a`, `A`).
2. Call Cognito `InitiateAuth` with:
   - `AuthFlow: USER_SRP_AUTH`
   - `USERNAME`
   - `SRP_A`
   - `SECRET_HASH`
3. Receive `PASSWORD_VERIFIER` challenge (`SRP_B`, `SALT`, `SECRET_BLOCK`, `USER_ID_FOR_SRP`).
4. Derive HKDF key from SRP math and sign challenge payload.
5. Call `RespondToAuthChallenge` with:
   - `TIMESTAMP`
   - `PASSWORD_CLAIM_SECRET_BLOCK`
   - `PASSWORD_CLAIM_SIGNATURE`
   - `SECRET_HASH`
   - `USERNAME` (must be original login username/email)
6. Persist `userId`, `accessToken`, `refreshToken`, `accessExpiresAt`.

### Refresh Steps (`refreshAccessToken`)

1. Call Cognito `InitiateAuth` with:
   - `AuthFlow: REFRESH_TOKEN`
   - `REFRESH_TOKEN`
   - `SECRET_HASH` built from `userId`
2. Persist new `accessToken` + expiry; keep same refresh token.

### Fallback Strategy

`resolveWinixAuthState()`:

1. If stored access token is still fresh, use it.
2. Else try refresh token.
3. If refresh fails, do full login.

This is needed because Winix sessions can be invalidated by other app logins.

## Account and Device Resolution

After auth:

1. Build synthetic UUID from access token `sub` using known Winix pattern.
2. Call `/registerUser`.
3. Call `/checkAccessToken`.
4. Call `/getDeviceInfoList`.
5. Use first device returned.

Device control uses:

- State: `GET /common/event/sttus/devices/{deviceId}`
- Control: `GET /common/control/devices/{deviceId}/A211/{attribute}:{value}`

## Data Persistence

### `winix_auth_state`

Single-row auth cache (`id=1`):

- `user_id`
- `access_token`
- `refresh_token`
- `access_expires_at`
- `updated_ts`

### `winix_control_state`

Single-row control status (`id=1`):

- `last_speed`
- `last_change_ts`
- `last_pm25_avg`
- `last_sample_ts`
- `error_streak`
- `last_error`
- `updated_ts`

## Troubleshooting

1. `last_error` contains `"Unable to verify secret hash"`:
   - check `WINIX_USERNAME` and `WINIX_PASSWORD` secrets
   - confirm login username casing exactly matches Winix account
2. `last_error` indicates stale PM2.5:
   - verify `WINIX_MONITOR_DEVICE_ID`
   - verify monitor ingest cadence
3. No device found:
   - account has no shared devices or first device is unavailable
4. Unexpected fan behavior:
   - inspect `WINIX_DEADBAND_UGM3` and `WINIX_MIN_DWELL_MINUTES`

## Intentional Defaults

- Device targeting: first device in Winix account list.
- Failure mode: hold prior speed; do not force turbo.
- Manual changes: automation re-applies desired speed each cycle.
