ALTER TABLE samples_raw ADD COLUMN pm10_ugm3 REAL;
ALTER TABLE samples_raw ADD COLUMN noise_db REAL;
ALTER TABLE samples_hourly ADD COLUMN pm10_avg REAL;
ALTER TABLE samples_hourly ADD COLUMN pm10_min REAL;
ALTER TABLE samples_hourly ADD COLUMN pm10_max REAL;
ALTER TABLE samples_hourly ADD COLUMN noise_avg REAL;
ALTER TABLE samples_hourly ADD COLUMN noise_min REAL;
ALTER TABLE samples_hourly ADD COLUMN noise_max REAL;

-- This device is populated by the Worker, not signed sensor ingestion.
-- An empty secret makes verifyDeviceRequest reject external ingest for it.
INSERT INTO devices (device_id, secret_hash, timezone)
VALUES ('bellezea-outdoor', '', 'Asia/Kolkata')
ON CONFLICT(device_id) DO NOTHING;
