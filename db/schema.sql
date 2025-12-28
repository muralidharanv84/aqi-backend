CREATE TABLE IF NOT EXISTS devices (
    device_id     TEXT PRIMARY KEY,
    secret_hash   TEXT NOT NULL,
    timezone      TEXT NOT NULL
);


CREATE TABLE IF NOT EXISTS samples_raw (
    device_id     TEXT NOT NULL,
    ts            INTEGER NOT NULL,   -- server time, epoch seconds (minute-bucketed)

    pm25_ugm3     REAL,
    aqi_us        INTEGER,

    co2_ppm       REAL,

    voc_ppm       REAL,
    voc_index     REAL,

    temp_c        REAL,
    rh_pct        REAL,

    PRIMARY KEY (device_id, ts),
    FOREIGN KEY (device_id) REFERENCES devices(device_id)
);

CREATE INDEX IF NOT EXISTS idx_samples_raw_device_ts
    ON samples_raw(device_id, ts);

CREATE TABLE IF NOT EXISTS samples_hourly (
    device_id     TEXT NOT NULL,
    hour_ts       INTEGER NOT NULL,   -- epoch seconds at hour boundary

    pm25_avg      REAL,
    pm25_min      REAL,
    pm25_max      REAL,

    aqi_avg       REAL,
    aqi_min       INTEGER,
    aqi_max       INTEGER,

    co2_avg       REAL,
    co2_min       REAL,
    co2_max       REAL,

    voc_ppm_avg   REAL,
    voc_ppm_min   REAL,
    voc_ppm_max   REAL,

    voc_index_avg REAL,
    voc_index_min REAL,
    voc_index_max REAL,

    temp_avg      REAL,
    temp_min      REAL,
    temp_max      REAL,

    rh_avg        REAL,
    rh_min        REAL,
    rh_max        REAL,

    n             INTEGER NOT NULL,

    PRIMARY KEY (device_id, hour_ts),
    FOREIGN KEY (device_id) REFERENCES devices(device_id)
);

CREATE INDEX IF NOT EXISTS idx_samples_hourly_device_ts
    ON samples_hourly(device_id, hour_ts);

