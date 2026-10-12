-- Permanently retire this device. Remove dependent history before its HMAC key.
-- Wrangler executes this file atomically; safe to rerun.
DELETE FROM samples_raw WHERE device_id = 'murali-1';
DELETE FROM samples_hourly WHERE device_id = 'murali-1';
DELETE FROM winix_control_log WHERE monitor_device_id = 'murali-1';
DELETE FROM devices WHERE device_id = 'murali-1';
