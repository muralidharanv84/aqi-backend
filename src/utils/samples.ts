import { METRIC_FIELDS, type MetricField } from "./metrics";

// Column identifiers come only from the static metric allowlist.
const UPSERT_SQL = `
  INSERT INTO samples_raw (device_id, ts, ${METRIC_FIELDS.join(", ")})
  VALUES (?, ?, ${METRIC_FIELDS.map(() => "?").join(", ")})
  ON CONFLICT(device_id, ts) DO UPDATE SET
    ${METRIC_FIELDS.map(field => `${field} = excluded.${field}`).join(", ")}
`;

export async function writeSample(
  db: D1Database,
  deviceId: string,
  ts: number,
  metrics: Partial<Record<MetricField, number | null>>,
): Promise<void> {
  await db.prepare(UPSERT_SQL)
    .bind(deviceId, ts, ...METRIC_FIELDS.map(field => metrics[field] ?? null))
    .run();
}
