#!/bin/bash

DEVICE_ID="livingroom-01"
TZ="Asia/Kolkata"

HASH=$(printf "%s" "$SECRET" | shasum -a 256 | awk '{print $1}')

echo "DEVICE SECRET (store in firmware): $SECRET"
echo "Storing hash in DB: $HASH"

wrangler d1 execute aqi_db --remote --command="
INSERT INTO devices (device_id, secret_hash, timezone)
VALUES ('$DEVICE_ID', '$HASH', '$TZ');
"
