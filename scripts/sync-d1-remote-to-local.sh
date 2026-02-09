#!/usr/bin/env bash
set -euo pipefail

DB_NAME="${1:-aqi_db}"
TMP_SQL="${TMPDIR:-/tmp}/${DB_NAME}.remote.$$.sql"

cleanup() {
  rm -f "$TMP_SQL"
}
trap cleanup EXIT

echo "Exporting remote D1 (${DB_NAME})..."
npx wrangler d1 export "$DB_NAME" --remote --output "$TMP_SQL" >/dev/null

echo "Resetting local D1 tables..."
npx wrangler d1 execute "$DB_NAME" --command="DROP TABLE IF EXISTS winix_auth_state; DROP TABLE IF EXISTS winix_control_log; DROP TABLE IF EXISTS samples_hourly; DROP TABLE IF EXISTS samples_raw; DROP TABLE IF EXISTS devices; DROP TABLE IF EXISTS _cf_KV; DROP TABLE IF EXISTS d1_migrations;" >/dev/null

echo "Importing remote snapshot into local D1..."
npx wrangler d1 execute "$DB_NAME" --file "$TMP_SQL" >/dev/null

echo "Done. Local D1 now mirrors remote snapshot for ${DB_NAME}."
