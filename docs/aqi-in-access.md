# Programmatic access to the Muthanallur AQI monitor

Verified on 15 September 2026 with Node and a **remote Cloudflare Worker preview**.

## Working approach

Two HTTPS GETs retrieve the public readings for monitor `8CBFEA3754B4`:

1. Fetch `https://dash.aqi.in/auth/login` without cookies or credentials.
2. Extract `siteStore.token2` from the Next.js data in that HTML. This is a visitor
   bearer token published in the unauthenticated page, not the owner's login token.
3. Request the endpoint below with `Authorization: bearer <visitor-token>`.

```text
https://apiserver.aqi.in/aqi/v2/getLocationDetailsBySlug?slug=india/karnataka/bangalore/muthanallur&type=4&source=aqi-dashboard
```

The request shape is present in the dashboard's public JavaScript asset
`/_next/static/chunks/3193-191d68e87ae1551f.js` (module `46412`, as inspected on the
verification date). The returned `uid` exactly matches the device on the owner's
[dashboard](https://dash.aqi.in/devices/8CBFEA3754B4) and its
[public page](https://www.aqi.in/dashboard/india/karnataka/bangalore/muthanallur).

Without the bearer header the endpoint returned HTTP 401. With the freshly
extracted visitor token it returned HTTP 200 from both Node and Cloudflare.
Fetching the public page HTML directly returned a bot challenge (403), so the
implementation uses the dashboard login page for token discovery.

No browser automation, personal account session, API key, login password, or
persistent token storage is needed. The token observed during verification had a
seven-day lifetime. The client obtains the currently published token on every
poll and checks its expiry; it does not hardcode that token or assume the lifetime
will remain the same. If AQI publishes an expired token, polling fails explicitly.

## Run it now

From this repository, with Node 22.6 or newer:

```bash
npm run aqi:probe
```

This runs `scripts/aqi-in-probe.mjs` against the live service using the same
dependency-free TypeScript client used by the Worker example.

Example result returned by the remote Worker at 09:04 IST:

```json
{
  "uid": "8CBFEA3754B4",
  "slug": "india/karnataka/bangalore/muthanallur",
  "observedAt": "2026-09-15T03:21:23.108Z",
  "fetchedAt": "2026-09-15T03:34:22.661Z",
  "online": true,
  "metrics": {
    "pm25_ugm3": 32,
    "pm10_ugm3": 39,
    "noise_db": 50,
    "tvoc_ppm": 34.374
  }
}
```

These are a recorded example, not permanently current values.

## Data meaning and freshness

| API field | Client field | Meaning |
| --- | --- | --- |
| `iaqi.pm25` | `metrics.pm25_ugm3` | PM2.5 concentration, µg/m³ |
| `iaqi.pm10` | `metrics.pm10_ugm3` | PM10 concentration, µg/m³ |
| `iaqi.noise` | `metrics.noise_db` | Noise, dB |
| `iaqi.tvoc` | `metrics.tvoc_ppm` | TVOC, labeled ppm on the owner's dashboard |
| `updatedAt` | `observedAt` | UTC update time supplied by the public API |
| `isOnline` | `online` | Provider's online flag |

**Use `updatedAt`, not `updated_at`.** In the observed response, `updatedAt` was
`03:21:23.108Z`, while `updated_at` was `08:51:23.000Z`: the latter represents IST
wall time but is incorrectly labeled as UTC. Do not timestamp an old reading
with the time of the poll.

The public API can lag: repeated requests during this investigation returned the
same snapshot, about 13 minutes old at the time of the remote Worker test, even
with `isOnline: true`. Polling every 10 minutes does not guarantee a new sensor
measurement every 10 minutes. Store `observedAt` and `fetchedAt`, deduplicate by
`(uid, observedAt)`, and assess freshness independently of `isOnline`. The example
skips offline readings and snapshots older than 30 minutes.

The public response also has `weather.temp_c` and `weather.humidity`. Those values
differed from the monitor's temperature/humidity readings in the owner's
dashboard. The client deliberately excludes weather fields from sensor metrics.
PM1, particle counts, and the monitor's temperature/humidity were visible in the
owner dashboard but absent from `iaqi` in the public response. This implementation
retrieves the public subset; it does not implement private-dashboard access.

## Production cron and storage

The `aqi-backend` Worker dispatches two cron expressions:

| Cron | Work |
| --- | --- |
| `*/5 * * * *` | Existing aggregation, Winix control, and log retention |
| `*/10 * * * *` | Fetch the outdoor monitor and write `bellezea-outdoor` |

Dispatch uses `event.cron`, so delayed delivery does not cause a ten-minute poll
to be skipped. Each async job is attached to `ctx.waitUntil()`. See Cloudflare's
[Scheduled Handler reference](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/)
and [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/).

`src/cron/aqiIn.ts` stores PM2.5, PM10, noise, TVOC (as `voc_ppm`), and a calculated
US AQI in `samples_raw`. It rejects offline data and snapshots older than 30
minutes. Rows use the source UTC time, rounded down to the minute to match the
existing sample schema. Repeated snapshots upsert the same `(device_id, ts)` row.
The existing aggregation job rolls the values into `samples_hourly`.

The migration registers `bellezea-outdoor` in `Asia/Kolkata` with an empty ingest
key. That intentionally disables external signed ingestion for this Worker-managed
source. The existing custom monitor keys are unaffected.

### AQI uses the custom-monitor calculation

The client discards both provider AQI fields (`iaqi.aqi` and `iaqi.AQI-IN`).
`src/utils/aqi.ts` ports `aqi_us_from_pm25` from the custom monitor firmware in
`airqualitymonitor/device/utils.py` (commit
`4805e1ca354f5b85c63d21bbbde59ad2c3318e74`). It preserves:

- PM2.5 truncation to one decimal place;
- the firmware's existing breakpoint table, including the 0–12 µg/m³ first band;
- Python's ties-to-even rounding (for example, PM2.5 3 gives AQI 12, not 13);
- the AQI cap of 500.

The port was compared directly with the Python function for 50,102 inputs: every
hundredth from 0 through 501 µg/m³, plus 1000 µg/m³. Every output matched. This
preserves the monitors' current algorithm rather than silently changing their
AQI standard. The firmware itself is not modified.

### Database upgrade and deployment

The migration and both schedules were deployed on 15 September 2026. Worker
version: `5972ec12-e2e0-4ddc-89cb-36e4f0c574be`.

A one-off invocation of the same polling job from a temporary remote Worker
verified the first production D1 write while the new cron propagated. The live
latest-reading API returned HTTP 200 with PM2.5 39, PM10 46, noise 84, TVOC 34.374,
and calculated AQI 110, for source minute `2026-09-15T03:41:00Z`. This was a manual
verification of the job, not evidence of the first automatic cron tick.

For an existing database, apply this migration once before deploying:

```bash
npx wrangler d1 execute aqi_db --remote --file db/migrations/0002_aqi_in_outdoor.sql
npm run deploy
```

It adds nullable PM10/noise columns to raw/hourly storage and registers the device.
New databases using `db/schema.sql` already include these changes. The numbered
SQL migrations in this repository are applied explicitly with `d1 execute`; do
not reapply an already executed `ALTER TABLE` migration.

### Read stored data

```text
GET /api/v1/devices/bellezea-outdoor/latest
GET /api/v1/devices/bellezea-outdoor/series?metric=aqi_us&from=<epoch>&to=<epoch>&resolution=raw
GET /api/v1/devices/bellezea-outdoor/series?metric=pm10_ugm3&from=<epoch>&to=<epoch>&resolution=1h
GET /api/v1/devices/bellezea-outdoor/series?metric=noise_db&from=<epoch>&to=<epoch>&resolution=raw
```

`aqi_us` is the locally calculated value. The latest-reading API includes all
available stored metrics. The frontend already displays PM2.5, AQI, and TVOC;
PM10 and noise are retained and queryable through the API but have no dedicated
frontend cards yet.

The initial investigation used a temporary remote Worker preview to verify AQI
access from Cloudflare. `examples/aqi-in` remains a standalone logging example;
production polling is part of the main backend, so do not deploy the example to
activate it.

## Operational behavior

- Two ordinary GETs per successful poll: 144 polls / 288 requests per day.
- Each request has a 15-second timeout and a 512 KiB response limit.
- Redirects are handled manually and rejected; bearer tokens are never forwarded
  to redirect destinations. The remote test caught that Workers rejects the
  `redirect: "error"` mode supported by Node; the client uses `"manual"`.
- The client validates the monitor UID, location slug, required PM2.5, online
  flag, token expiry, and UTC timestamp. It preserves zero values and represents
  absent optional metrics as `null`.
- No tight retry loop. HTTP failures (including 401, 403, and 429), markup changes,
  and unexpected payloads fail visibly; the next scheduled tick can try again.
- Tokens, HTML bootstrap bodies, and arbitrary upstream error bodies are not
  logged or returned to callers.

This is an **unofficial website API**, with no stability guarantee or documented
polling allowance established here. Token rendering, endpoint behavior, or
availability may change. Keeping discovery and response parsing in one small
client makes those changes easier to diagnose.

## Verification

- Live unauthenticated HTML bootstrap + authenticated public API GET from Node.
- Live HTTP 200 with the expected monitor UID from a remote Cloudflare Worker.
- Local Workers tests cover token extraction/expiry, exact monitor matching,
  timestamps, missing/invalid/zero readings, offline state, redirects, HTTP
  failures, response limits, and absence of cookies or token disclosure.
- Repository TypeScript check and standalone Worker deployment dry run.

The production integration is covered by D1 write/deduplication, stale/offline
handling, raw/hourly API, cron dispatch, and signed-ingest rejection tests.
All 87 repository tests pass, as do TypeScript and the Worker deployment dry run.
