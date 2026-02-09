# aqi-backend
Backend for the air quality monitor to log data

## Localflare + D1

`localflare` runs with a local multi-worker runtime. In this mode, `--remote` D1 is not supported, so Localflare can show an empty local DB even when remote D1 has data.

To sync remote D1 into local D1 before using Localflare:

```bash
npm run db:sync:remote-to-local
npm run localflare
```

Or run both in one command:

```bash
npm run localflare:with-remote-d1
```
