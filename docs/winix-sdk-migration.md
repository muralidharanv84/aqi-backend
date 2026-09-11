# Winix SDK Integration

The backend uses our open-source `winix-control-sdk@0.3.0` for authentication,
account discovery, and device commands. The SDK was extracted in February 2026;
version 0.3.0 updates it for Winix's current cloud protocol and replaces the
temporary `winix-api` workaround used during the September control outage.

## Ownership

- `winix-control-sdk`: public-client Cognito SRP and refresh, ID tokens, encrypted
  mobile requests, identity lookup, device state and commands, and protocol tests.
- `src/winix/client.ts`: one authenticated SDK client per control cycle and a
  fresh-login retry if account session setup fails.
- `src/cron/winixControl.ts`: sensor freshness, PM2.5 thresholds, hysteresis,
  dwell policy, target selection, and D1 persistence.

The SDK has no runtime dependencies and uses native fetch and Web Crypto in
Cloudflare Workers. The backend no longer needs AWS client aliases or duplicate
protocol and authentication implementations.

## Upgrading from SDK 0.2.x

Version 0.3.0 replaces the shared `defaultWinixDeviceClient` with
`createWinixDeviceClient(session.identityId)`. Auth state now includes an ID token;
legacy cached state is refreshed or replaced through a full login automatically.
Token expiry remains epoch seconds.

The backend requires the `id_token` column added by
`db/migrations/0001_winix_id_token.sql`. Apply that migration once to older
installations before deploying. It is already present in production.

See [Winix Control](winix-control.md) for configuration, persistence, and runtime
verification, and the [SDK repository](https://github.com/muralidharanv84/winix-control-sdk)
for the public API and release history.
