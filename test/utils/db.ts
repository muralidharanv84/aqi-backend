const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS devices (
    device_id     TEXT PRIMARY KEY,
    secret_hash   TEXT NOT NULL,
    timezone      TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS samples_raw (
    device_id     TEXT NOT NULL,
    ts            INTEGER NOT NULL,
    pm25_ugm3     REAL,
    aqi_us        INTEGER,
    co2_ppm       REAL,
    voc_ppm       REAL,
    voc_index     REAL,
    temp_c        REAL,
    rh_pct        REAL,
    PRIMARY KEY (device_id, ts),
    FOREIGN KEY (device_id) REFERENCES devices(device_id)
  );`,
  `CREATE TABLE IF NOT EXISTS samples_hourly (
    device_id     TEXT NOT NULL,
    hour_ts       INTEGER NOT NULL,
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
  );`,
];

export async function resetDb(db: D1Database): Promise<void> {
  for (const stmt of SCHEMA_STATEMENTS) {
    await db.prepare(stmt).run();
  }
  await db.prepare("DELETE FROM samples_hourly").run();
  await db.prepare("DELETE FROM samples_raw").run();
  await db.prepare("DELETE FROM devices").run();
}

export async function insertDevice(
  db: D1Database,
  deviceId: string,
  secret: string,
  timezone = "UTC",
): Promise<void> {
  await db
    .prepare("INSERT INTO devices (device_id, secret_hash, timezone) VALUES (?, ?, ?)")
    .bind(deviceId, secret, timezone)
    .run();
}

type SampleMetrics = Partial<{
  pm25_ugm3: number;
  aqi_us: number;
  co2_ppm: number;
  voc_ppm: number;
  voc_index: number;
  temp_c: number;
  rh_pct: number;
}>;

type HourlyMetrics = Partial<{
  pm25_avg: number;
  pm25_min: number;
  pm25_max: number;
  aqi_avg: number;
  aqi_min: number;
  aqi_max: number;
  co2_avg: number;
  co2_min: number;
  co2_max: number;
  voc_ppm_avg: number;
  voc_ppm_min: number;
  voc_ppm_max: number;
  voc_index_avg: number;
  voc_index_min: number;
  voc_index_max: number;
  temp_avg: number;
  temp_min: number;
  temp_max: number;
  rh_avg: number;
  rh_min: number;
  rh_max: number;
}>;

export async function insertSample(
  db: D1Database,
  deviceId: string,
  ts: number,
  metrics: SampleMetrics,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO samples_raw (
        device_id,
        ts,
        pm25_ugm3,
        aqi_us,
        co2_ppm,
        voc_ppm,
        voc_index,
        temp_c,
        rh_pct
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      deviceId,
      ts,
      metrics.pm25_ugm3 ?? null,
      metrics.aqi_us ?? null,
      metrics.co2_ppm ?? null,
      metrics.voc_ppm ?? null,
      metrics.voc_index ?? null,
      metrics.temp_c ?? null,
      metrics.rh_pct ?? null,
    )
    .run();
}

export async function insertHourlySample(
  db: D1Database,
  deviceId: string,
  hourTs: number,
  metrics: HourlyMetrics,
  n = 60,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO samples_hourly (
        device_id,
        hour_ts,
        pm25_avg,
        pm25_min,
        pm25_max,
        aqi_avg,
        aqi_min,
        aqi_max,
        co2_avg,
        co2_min,
        co2_max,
        voc_ppm_avg,
        voc_ppm_min,
        voc_ppm_max,
        voc_index_avg,
        voc_index_min,
        voc_index_max,
        temp_avg,
        temp_min,
        temp_max,
        rh_avg,
        rh_min,
        rh_max,
        n
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      deviceId,
      hourTs,
      metrics.pm25_avg ?? null,
      metrics.pm25_min ?? null,
      metrics.pm25_max ?? null,
      metrics.aqi_avg ?? null,
      metrics.aqi_min ?? null,
      metrics.aqi_max ?? null,
      metrics.co2_avg ?? null,
      metrics.co2_min ?? null,
      metrics.co2_max ?? null,
      metrics.voc_ppm_avg ?? null,
      metrics.voc_ppm_min ?? null,
      metrics.voc_ppm_max ?? null,
      metrics.voc_index_avg ?? null,
      metrics.voc_index_min ?? null,
      metrics.voc_index_max ?? null,
      metrics.temp_avg ?? null,
      metrics.temp_min ?? null,
      metrics.temp_max ?? null,
      metrics.rh_avg ?? null,
      metrics.rh_min ?? null,
      metrics.rh_max ?? null,
      n,
    )
    .run();
}
