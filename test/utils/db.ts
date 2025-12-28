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
];

export async function resetDb(db: D1Database): Promise<void> {
  for (const stmt of SCHEMA_STATEMENTS) {
    await db.prepare(stmt).run();
  }
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
