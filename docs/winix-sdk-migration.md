# Winix SDK Migration Checklist

This document tracks migration from in-repo Winix modules to the shared
`winix-control-sdk` package.

## Objectives

- Extract reusable Winix logic into a standalone package.
- Keep this backend focused on app-specific control orchestration and D1 state.
- Preserve control behavior and existing runtime env variable contracts.

## Extraction Status

- [x] Reusable modules moved to `/Users/murali/code/winix-control-sdk`.
- [x] Control helper functions remain in `aqi-backend` (`src/cron/winixControl.ts`) as app-specific logic.
- [x] `aqi-backend` `runWinixControlLoop` imports from `winix-control-sdk`.
- [x] In-repo `src/winix/*` files removed.
- [x] Backend tests updated to import Winix types/auth APIs from package.
- [x] Backend docs updated to reference package-backed implementation.
- [x] Public GitHub repo created at `muralidharanv84/winix-control-sdk`.
- [x] npm package published as `winix-control-sdk@0.2.0`.

## Behavior Parity Acceptance Criteria

- [x] Token handling parity:
  - Stored fresh token is reused.
  - Expired token refresh is attempted.
  - Refresh failure falls back to full login.
- [x] Device control command order parity:
  - Read state.
  - Ensure `power on`.
  - Ensure `manual mode`.
  - Apply `target airflow`.
- [x] Stale-window safety parity:
  - Skip control when sample count is below threshold.
  - Skip control when last sample age is above threshold.
  - Persist `skipped_stale` log rows.
- [x] D1 persistence parity:
  - `winix_auth_state` remains source of cached auth.
  - `winix_control_log` remains append-only run history.

## Rollback Plan

1. Revert `aqi-backend` to pre-migration commit where `src/winix/*` exists.
2. Reinstall dependencies (`npm ci`) and rerun tests.
3. Deploy rollback revision.
4. If package-origin regression is identified, pin package to last known good
   version before reattempting migration.
