# Programmatic access to the Muthanallur AQI monitor

## Current integration — October 2026

`* * * * *` polls authenticated device data through the `AqiSession` Durable
Object named `bellezea-outdoor`. Its storage holds the account bearer token and
rotation/incident state; no token is written to D1, source code, logs, or API
responses. Cloudflare protects Durable Object storage at rest. Operators with
account access or the `AQI_ADMIN_KEY` can administer the session.

The poller stores PM2.5, PM10, noise, TVOC, device temperature (`temp_c`), humidity
(`rh_pct`), and the existing locally calculated US AQI. Existing raw/hourly
schemas and APIs already support temperature/humidity; no new D1 migration is
needed. Source times are parsed explicitly as IST, including AM/PM, before UTC
minute bucketing. Invalid values/units, another serial, and future times fail
validation. Private data must be online and at most five minutes old.

Renewal runs daily, or halfway to expiry for shorter-lived credentials. The
single object serializes reads, seeding and refresh. Before requesting refresh
it durably records a pending rotation. After a successful response it saves the
replacement before making another request. A lost response or interrupted
rotation requires reseeding rather than replaying a potentially revoked token.
AQI's cumulative session-age limit is undocumented; failures are handled by
fallback and reminders rather than a promise of indefinite session validity.

On private-source failure the public reader runs immediately, then at most every
ten minutes. Public readings retain their original timestamps and thirty-minute
freshness limit. Fallback only inserts missing source-minute rows, so it cannot
remove temperature/humidity or replace an authenticated reading from the same
minute. No weather temperature/humidity is substituted for device measurements.

Authentication failures lasting fifteen minutes and at least three checks send
one email to `muralidharan@gmail.com` from the existing verified alert sender
`alerts@calorie-alerts.muralidharan.fyi`. Reminders repeat at most once per IST day
and no sooner than 24 hours after the previous successful send. Success clears
the incident; the daily limit remains across recovery/re-failure. The send is
reserved before delivery to prevent duplicates after an ambiguous mail failure;
an unsuccessful send is logged and retried on the next eligible day. HTTP 429,
5xx, stale readings and other transport/data problems alone are not auth failures.

### Renewal window and automatic password sign-in — 27 October 2026

Production failed at the first daily renewal after 14 days (seeded 13 Oct 03:29Z,
renewal refused from 27 Oct; authenticated rows stop at 04:58Z). Bearer refresh
preserves the original sign-in `iat`, so AQI enforces a cumulative **14-day
renewal window** even though each token is valid for 28 days. The auth alert
email fired on time but Gmail filed it as spam; a Gmail filter now keeps
`alerts@calorie-alerts.muralidharan.fyi` out of Spam.

Changes:

- A definite renewal refusal (HTTP 401/403 or a token-related `status: 0`)
  no longer discards the token. The session sets `refreshClosed`, keeps using
  the token until it expires, and stops retrying refresh. Uncertain refresh
  outcomes still discard the token, as before.
- When renewal is refused, the token is rejected, or no session exists, the
  worker signs in with `POST /api/v1/login` (`{ email, password }`), which
  starts a new session and a new 14-day window. The email is the
  `AQI_LOGIN_EMAIL` var; the password is the `AQI_PASSWORD` Worker secret.
  Attempts are reserved before sending and limited to one per 30 minutes.
  The password is never logged, stored in Durable Object state, or returned.
- If the session cannot be renewed and expires within 3 days, an
  "expires soon" email is sent once per IST day. Auth-failure emails now
  include the password sign-in error.
- `node scripts/aqi-admin.mjs verify-login --key-file .dev.vars.admin-key`
  signs in with the stored password and reads the device without changing
  stored state. It returns only `loginOk`, `validityMinutes`, the device
  timestamp, or an error code, plus response field names (no values) if
  AQI answers in an unrecognized format.

Password sign-in for this Google-created account was enabled by setting a
password through **Forgot Password?** on 27 Oct 2026. Run `verify-login` after
deploying to confirm AQI accepts it.

### Operator setup and recovery

Set a strong random Worker secret with `wrangler secret put AQI_ADMIN_KEY`.
The endpoints below require `Authorization: Bearer <AQI_ADMIN_KEY>`, return
`Cache-Control: no-store`, and never return account credentials. Keep operator
keys and account-token files private and outside Git. Rotating the operator key
does not reset the Durable Object's account token.

```bash
node scripts/aqi-admin.mjs status --key-file /private/path/operator-key
node scripts/aqi-admin.mjs seed --key-file /private/path/operator-key --token-file /private/path/aqi-session.json
node scripts/aqi-admin.mjs refresh --key-file /private/path/operator-key
node scripts/aqi-admin.mjs poll --key-file /private/path/operator-key
node scripts/aqi-admin.mjs verify-fallback --key-file /private/path/operator-key
node scripts/aqi-admin.mjs test-email --key-file /private/path/operator-key
```

The seed file is JSON with a `token` property containing a current account JWT
obtained through the owner's signed-in AQI session. Seed validates device access
before replacing any working session. Delete the temporary seed file afterward.
The first backend refresh invalidates the browser token used to seed it: sign
back into the dashboard with Google afterward so browser and backend use separate
sessions. No Google credentials or Google refresh tokens are required.

`GET /internal/aqi/status` exposes sanitized session/incident metadata.
`POST /internal/aqi/session`, `/refresh`, `/poll`, `/test-email`, and
`/verify-fallback` are the corresponding maintenance actions. Fallback verification
uses a separate unseeded object and deletes its state afterward; it never changes
the production token or writes a simulated failure into production samples.
The test-email action sends an explicitly labeled delivery test, not an outage
notification. Admin CORS allows only the AQI dashboard origin, and actual requests
still require the operator key. Public data routes retain their existing CORS.

The `aqi-session-v1` Wrangler migration creates the SQLite-backed Durable Object
namespace. The five-minute aggregation/Winix cron is unchanged.

### Production verification — 13 October 2026

Worker version `9a913602-8a22-4c4f-8c99-9a81188c128a` was deployed with
the account session seeded and refreshed from Cloudflare. The replacement token
was persisted and successfully used for subsequent device reads. Signing back
into Chrome with Google did not invalidate the backend's separate session.

The live latest API returned PM2.5 51, PM10 65, noise 55, TVOC 8.396,
local US AQI 139, temperature 26.2°C and humidity 58% for source minute
`2026-10-13T04:25:00Z`. The isolated missing-authentication check returned the
public snapshot with its original `04:11:24Z` timestamp. The labeled email
delivery test was received in the configured Gmail inbox at `04:25:46Z`.

After cron propagation, automatic `* * * * *` events at `04:32:58Z` and
`04:33:58Z` both completed successfully with no exceptions and logged
`source: private`. D1 independently confirmed consecutive source-minute rows
at `04:32:00Z` and `04:33:00Z`, with all seven metrics populated (including
26.2°C and 57% RH). No manual poll was issued between these scheduled runs.
Live temperature/humidity series returned HTTP 200; an unauthenticated admin
status request returned HTTP 401. Session status reported zero auth failures.

All 128 repository tests pass, together with TypeScript and deployment dry-run
checks. Tests cover scheduled renewal, durable rotation/restart behavior,
authentication fallback, daily reminder limits and recovery, parsing, admin
authorization, and temperature/humidity through raw/hourly storage APIs.

## Investigation history

The following sections record the investigation and earlier public integration;
the current deployed design is described above.

## Authenticated real-time investigation — 13 October 2026

The owner's signed-in Chrome dashboard exposes fresher data for the same device.
At this stage the investigation confirmed browser access while production still
used the public client. Deployment and credential setup subsequently followed
the current integration described above. No account token or password was saved
to the repository.

Observed request on the [device dashboard](https://dash.aqi.in/devices/8CBFEA3754B4):

```text
GET https://airquality.aqi.in/api/v1/GetAllUserDevices
Authorization: bearer <account-token>
```

It returned HTTP 200, `status: 1`, and a `data` array containing
`serialNo: "8CBFEA3754B4"`, `isOnline: 1`, `device_timezone: "Asia/Kolkata"`,
`last_updated: "2026-10-13 09:06:19 AM"`, and `timeago: "14 seconds ago "`.
The response's HTTP Date was `2026-10-13T03:36:33Z`, consistent with the
device timestamp being IST wall time. Unlike the public endpoint's `updatedAt`,
this timestamp has no UTC offset: convert it explicitly using the device timezone,
including correct AM/PM handling. Do not parse it in the Worker's local timezone
or use the relative `timeago` string as the sample timestamp.

Each entry in `realtime` has `sensorid`, `sensorname`, `sensorvalue`, and `unit`:

| Sensor ID | Metric | Observed value |
| --- | --- | --- |
| 3 | PM2.5, µg/m³ | 62 |
| 4 | PM10, µg/m³ | 76 |
| 5 | PM1, µg/m³ | 35 |
| 11 | Device temperature, °C | 25.4 |
| 12 | Device humidity, % | 64 |
| 13 | Noise, dB | 50 |
| 18 | TVOC, ppm | 34.374 |

For comparison, `npm run aqi:probe` at `2026-10-13T03:37:49.747Z` returned
public `observedAt: "2026-10-13T03:21:23.704Z"`: about 16 minutes old.
Later reloads of the signed-in Real Time table showed changed values and ages
of 28 seconds and 14 seconds. This establishes fresher, changing readings,
but does not establish an exact device upload interval or an API service guarantee.

The dashboard's public JavaScript asset
`/_next/static/chunks/7577-239243ede56c6068.js` also defines a narrower request:

```text
GET https://airquality.aqi.in/api/v1/GetSingleUserDevicesDetails
Authorization: bearer <account-token>
serialno: 8CBFEA3754B4
```

That single-device route was identified in source, not tested during this
investigation. The observed dashboard request used `GetAllUserDevices`.

The account JWT's expiry claims indicate a 14-day lifetime: issued
13 October 2026 at 08:59:54 IST, expiring 27 October 2026 at 08:59:54 IST.
These are decoded claims, not a promise that the session cannot be revoked earlier.
The sign-in page calls a Next.js server action. The follow-up below establishes
a direct API renewal route; a copied browser token alone, without renewal and
durable replacement-token storage, is insufficient for long-term operation.

### Renewal and public-token follow-up

Further investigation on the same day found a working renewal route:

```text
POST https://airquality.aqi.in/api/v1/refresh
Authorization: bearer <current-token>
```

Test results:

| Credential / request | Result |
| --- | --- |
| Public `siteStore.token2` → `GetSingleUserDevicesDetails` for this serial | HTTP 200, `status: 0`, `Token is Invalid` |
| Public `siteStore.token2` → `GetAllUserDevices` | HTTP 200, `status: 0`, `Token is Invalid` |
| Public `siteStore.token` → `GetSingleUserDevicesDetails` for this serial | HTTP 200, `status: 0`, `No device found`, empty data |
| Public `siteStore.token` → `POST /refresh` | HTTP 200 with a replacement `token`, `token_type: bearer`, and `token_validity: 120` |
| Original public `siteStore.token` after renewal → device request | `Token is Invalid` |

The login page publishes **two different visitor tokens**. `token2` is the
public-location API credential used by this repository; `token` is issued by
the `airquality.aqi.in` authentication service. Neither retrieved this device's
private data in these tests. Check the JSON status even when HTTP is 200.

The visitor account's refresh response advertised `token_validity: 120`.
Do not reuse the published visitor token for additional renewal experiments:
refresh invalidates the input token. The current public-location integration
uses the separate `token2` credential, which was not refreshed.

**Account renewal was then verified successfully.** The owner's original token
had issuer `http://airquality.aqi.in/api/v1/SignInWithGoogle`. Passing it to
`POST /refresh` returned a new token with `token_validity: 40320` (28 days), and
that replacement successfully fetched this exact device using
`GetSingleUserDevicesDetails`. Refreshing the replacement a second time also
succeeded; the latest token fetched the device while its predecessor returned
`status: 0, msg: "Token is Invalid"`.

Sanitized second-renewal results:

```json
{
  "refreshHttp": 200,
  "validityMinutes": 40320,
  "iat": "2026-10-13T03:29:54.000Z",
  "nbf": "2026-10-13T03:58:37.000Z",
  "exp": "2026-11-10T03:58:37.000Z",
  "deviceHttp": 200,
  "deviceStatus": 1,
  "deviceMatched": true,
  "last_updated": "2026-10-13 09:28:20 AM"
}
```

This establishes a working renewal chain for Google-created AQI sessions without
a password or further Google OAuth exchange. It does **not** establish unlimited
session longevity: refresh preserves the original `iat`, and the service's
cumulative refresh window is undocumented. A backend should renew early (for
example daily), inspect the actual JWT expiry, serialize refresh operations, and
durably save each replacement token. A lost refresh response is significant
because the input token may already be invalid; blindly retrying it is unsafe.
Detect renewal failure explicitly and support reauthentication if AQI enforces
a cumulative deadline or revokes the session.

Rotating the original token invalidated the dashboard's existing browser session.
The browser was subsequently signed back in with its existing Google session;
both open device pages were restored. A backend should use its own seeded
session, independent of the token retained by the interactive dashboard.
The account-token test ran in Chrome; Cloudflare verification remains outstanding.

The Google login client requests `openid email profile` and `access_type: offline`
through AQI's own OAuth client. That alone does not establish that an AQI client
receives a Google refresh token or can use one directly. Prefer AQI's bearer
renewal endpoint, which worked for this account in the test above.

The signed-in My Account page shows a disabled password field and no visible
password-change control. The unauthenticated login page's **Forget Password?**
flow offers an email OTP followed by password reset. Its public account client
(`6702-b1d6a30ebf68d760.js`) uses:

1. `POST /api/v1/forgot-password` with `email`.
2. `POST /api/v1/verify-otp` with `email` and `otpcode`.
3. `POST /api/v1/SetUserNewPassword` with `email` and `password`.

The known `POST /api/v1/login` route, called without credentials, returned
HTTP 400 requiring `email` and `password`. This establishes a direct password
login API without dependence on the dashboard's Next.js action identifier.
No OTP was requested and no password was set. Whether this reset flow enables
password login for this Google-created account remains unverified; the account
owner should complete any password creation in the website UI.

Implementation plan at the time of investigation (now implemented above):

- Implement the verified account-token renewal flow with protected durable token
  storage, serialized rotation, and reauthentication handling; verify it from
  Cloudflare before deployment.
- Fetch the real-time device record every minute; match the exact serial number,
  validate units and values, and convert the observation timestamp to UTC.
- Preserve the existing local AQI calculation, source-minute deduplication,
  and offline/stale checks. Use a tighter freshness limit for real-time data.
- Define explicit handling for expired authentication and upstream errors;
  any public fallback must retain its original, older observation timestamp.
- Add parser, authentication-failure, timezone, cron, and D1 integration coverage
  before switching the deployed source.

## Existing public integration

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
