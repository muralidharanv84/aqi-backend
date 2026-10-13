-- Latest readings also look up purifier status for monitors without any logs.
-- Index both the monitor filter and newest-inserted ordering to avoid scanning
-- the entire retained control log for every outdoor/inactive-monitor request.
CREATE INDEX IF NOT EXISTS idx_winix_control_log_monitor_id
    ON winix_control_log(monitor_device_id, id DESC);
