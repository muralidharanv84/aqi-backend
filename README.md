# AQI Backend

Cloudflare Workers + D1 backend for air-quality ingestion, querying, hourly aggregation, and optional Winix purifier control automation.

## What This Service Does

- Accepts signed sensor payloads from AQI devices (`POST /api/v1/ingest`)
- Stores minute-bucketed samples in D1 (`samples_raw`)
- Serves latest readings and time-series data for dashboards
- Aggregates completed hourly windows into `samples_hourly`
- Optionally controls Winix purifier fan speed from PM2.5 trends every 5 minutes

## Architecture

```text
AQI Device(s)
  -> signed HTTP ingest
Cloudflare Worker
  -> D1 writes/reads
Frontend / API clients
  <- latest + series + devices

Cron (every 5 min)
  -> aggregateCompletedHours()
  -> runWinixControlLoop()
  -> enforceWinixControlLogRetention()
```

Core entrypoint: `src/index.ts`

## Tech Stack

- Cloudflare Workers (TypeScript)
- Cloudflare D1 (SQLite)
- Wrangler (`wrangler.jsonc`)
- Vitest + `@cloudflare/vitest-pool-workers`

## Project Structure

```text
src/
  index.ts                 # Request router + scheduled entrypoint
  routes/                  # HTTP handlers
  cron/                    # Aggregation + Winix scheduled jobs
  utils/                   # Auth, parsing, CORS, time helpers

db/schema.sql              # Full D1 schema
../winix-control-sdk       # Shared Winix SDK package (published as winix-control-sdk)
scripts/
  sync-d1-remote-to-local.sh

test/                      # Unit + integration tests
```

## Data Model

Tables in `db/schema.sql`:

- `devices`: registered AQI devices (`device_id`, `secret_hash`, `timezone`)
- `samples_raw`: minute-level metrics (one row/device/minute, UPSERT)
- `samples_hourly`: hourly rollups (`avg`, `min`, `max`, `n` per metric)
- `winix_auth_state`: cached Winix auth tokens (`id=1` single row)
- `winix_control_log`: append-only automation run log

## API

Base path: `/api/v1`

### `GET /api/v1/health`

Fast health probe (no DB):

```json
{ "ok": true }
```

### `GET /api/v1/devices`

Returns registered devices:

```json
{
  "devices": [
    { "device_id": "livingroom-01", "timezone": "Asia/Kolkata" }
  ]
}
```

### `POST /api/v1/ingest`

Signed device ingest endpoint.

Required headers:

- `X-Device-Id: <device_id>`
- `X-Signature: <hex_hmac_sha256(secret, raw_body)>`
- `Content-Type: application/json`

Allowed metric fields:

- `pm25_ugm3`
- `aqi_us` (must be integer)
- `co2_ppm`
- `voc_ppm`
- `voc_index`
- `temp_c`
- `rh_pct`

Rules:

- At least one metric is required
- Unknown fields are rejected
- Invalid/missing signature returns `401`
- Successful writes are minute-bucketed and idempotent per `(device_id, ts)`

Success response:

```json
{ "ok": true, "ts": 1766925000 }
```

### `GET /api/v1/devices/:deviceId/latest`

Returns latest raw sample for a device:

```json
{
  "device_id": "livingroom-01",
  "ts": 1766925000,
  "metrics": {
    "pm25_ugm3": 18.2,
    "aqi_us": 63
  },
  "fan_control": {
    "latest_event": {
      "run_ts": 1766925000,
      "status": "success",
      "purifier_device_ids": ["purifier-lr"],
      "speed": "medium",
      "error_message": null
    },
    "latest_error": {
      "run_ts": 1766924700,
      "status": "error",
      "message": "Auth failed",
      "error_streak": 2
    }
  }
}
```


`fan_control.latest_event` is the newest Winix control run for this monitor device.
`fan_control.latest_error` is the newest error/skipped-stale run with an error message.
If no Winix records exist for this monitor, both are `null`.

### `GET /api/v1/devices/:deviceId/series`

Query params:

- `metric`: one of supported metric fields
- `from`: epoch seconds (inclusive)
- `to`: epoch seconds (inclusive)
- `resolution`: `raw` or `1h`

Examples:

- Raw: `/api/v1/devices/livingroom-01/series?metric=pm25_ugm3&from=1700000000&to=1700003600&resolution=raw`
- Hourly: `/api/v1/devices/livingroom-01/series?metric=pm25_ugm3&from=1700000000&to=1700086400&resolution=1h`

Notes:

- `raw` range is capped at 14 days
- Invalid query parameters return `400`

### `GET /`

DB ping endpoint:

```json
{ "ok": 1, "now": "2026-02-09 10:00:00" }
```

## CORS Policy

Allowed origins:

- `https://aqi.orangeiqlabs.com`
- `https://aqi-web.pages.dev`
- `https://*.aqi-web.pages.dev` (preview subdomains over HTTPS)
- `http://localhost:3000`
- `http://localhost:5173`

Allowed request headers:

- `Content-Type, X-Device-Id, X-Signature`

## Scheduled Jobs (Every 5 Minutes)

Configured in `wrangler.jsonc`:

```json
"triggers": { "crons": ["*/5 * * * *"] }
```

Each tick runs:

1. `aggregateCompletedHours(env, nowMs)`
2. `runWinixControlLoop(env, nowMs)`
3. `enforceWinixControlLogRetention(env, nowMs)`

### Hourly Aggregation

- Runs per device timezone
- Aggregates the **last completed local hour** from `samples_raw`
- Upserts aggregate into `samples_hourly`
- Skips devices with zero samples in that window

## Winix Automation

The Winix control loop is optional and controlled by env vars.

Core Winix API/auth/device logic comes from the external npm package
`winix-control-sdk`; this repo keeps only deployment-specific orchestration,
device targeting, and D1 persistence.
PM2.5 thresholds, hysteresis behavior, and dwell policy are intentionally
implemented in this repo (`src/cron/winixControl.ts`) as app-specific logic.

### Required secrets

- `WINIX_USERNAME`
- `WINIX_PASSWORD`

### Runtime vars and defaults

- `WINIX_CONTROL_ENABLED` (default: `true`)
- `WINIX_DRY_RUN` (default: `false`)
- `WINIX_MONITOR_DEVICE_ID` (required when enabled)
- `WINIX_TARGET_DEVICE_IDS` (CSV, default: all account devices)
- `WINIX_DEADBAND_UGM3` (default: `2`)
- `WINIX_MIN_DWELL_MINUTES` (default: `10`)
- `WINIX_MIN_SAMPLES_5M` (default: `3`)
- `WINIX_MAX_SAMPLE_AGE_SECONDS` (default: `360`)

### Fan-speed mapping

- `< 10` -> `low`
- `< 20` -> `medium`
- `<= 30` -> `high`
- `> 30` -> `turbo`

Then hysteresis + dwell are applied to reduce speed flapping.

### Log retention

`winix_control_log` is pruned to a rolling 30-day window each scheduled run.

More detail: `docs/winix-control.md`

## Local Development

### 1. Install dependencies

```bash
npm ci
```

### 2. Apply schema to local D1

```bash
npx wrangler d1 execute aqi_db --local --file db/schema.sql
```

### 3. Run the Worker locally

```bash
npm run dev
```

Wrangler will load `.dev.vars` for local secrets/vars.

### 4. (Optional) Use Localflare with a remote D1 snapshot

```bash
npm run db:sync:remote-to-local
npm run localflare
```

Or one command:

```bash
npm run localflare:with-remote-d1
```

## Deployment

```bash
npm run deploy
```

Before first deploy in a new account/project:

1. Create D1 DB
2. Set `database_id` in `wrangler.jsonc`
3. Apply schema remotely:

```bash
npx wrangler d1 execute aqi_db --remote --file db/schema.sql
```

4. Set required secrets:

```bash
npx wrangler secret put WINIX_USERNAME
npx wrangler secret put WINIX_PASSWORD
```

## Device Provisioning

Insert a device key + timezone:

```sql
INSERT INTO devices (device_id, secret_hash, timezone)
VALUES ('livingroom-01', '<shared-hmac-key>', 'Asia/Kolkata');
```

`secret_hash` is the HMAC key used by the server for signature verification.
The device must sign the exact raw JSON payload with the same key.

Example Node.js signing snippet:

```js
import crypto from "node:crypto";

const key = process.env.DEVICE_KEY;
const body = JSON.stringify({ pm25_ugm3: 18.2, aqi_us: 63 });
const signature = crypto.createHmac("sha256", key).update(body).digest("hex");
```

## Testing

Run full suite:

```bash
npm test
```

Watch mode:

```bash
npm run test:watch
```

Coverage includes:

- endpoint behavior (`ingest`, `latest`, `series`, `devices`, health, CORS)
- aggregation logic across timezones
- Winix control loop decisioning and persistence
- scheduled job orchestration

## Useful Debug Queries

Latest raw sample per device:

```sql
SELECT *
FROM samples_raw
WHERE device_id = 'livingroom-01'
ORDER BY ts DESC
LIMIT 1;
```

Recent Winix control runs:

```sql
SELECT run_ts, run_status, pm25_avg, previous_speed, target_speed, effective_speed, error_message
FROM winix_control_log
ORDER BY id DESC
LIMIT 50;
```

## Notes

- Ingest timestamps are server-generated and minute-bucketed.
- `POST /api/v1/ingest` consumes the raw request body for signature verification before JSON parsing.
- Unknown metric fields intentionally fail fast with `400` to protect schema/API consistency.
