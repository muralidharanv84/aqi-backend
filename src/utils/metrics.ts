export const METRIC_FIELDS = [
  "pm25_ugm3",
  "aqi_us",
  "co2_ppm",
  "voc_ppm",
  "voc_index",
  "temp_c",
  "rh_pct",
] as const;

export type MetricField = (typeof METRIC_FIELDS)[number];
export type MetricsInput = Partial<Record<MetricField, number>>;

const ALLOWED_FIELDS = new Set<string>(METRIC_FIELDS);

export function parseMetrics(
  input: Record<string, unknown>,
): { metrics: MetricsInput; count: number } | { error: string } {
  for (const key of Object.keys(input)) {
    if (!ALLOWED_FIELDS.has(key)) return { error: "Unknown field" };
  }

  const metrics: MetricsInput = {};
  let count = 0;

  for (const field of METRIC_FIELDS) {
    if (!(field in input)) continue;
    const value = input[field];

    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { error: "Invalid metric value" };
    }

    if (field === "aqi_us" && !Number.isInteger(value)) {
      return { error: "Invalid metric value" };
    }

    metrics[field] = value;
    count += 1;
  }

  if (count === 0) return { error: "At least one metric required" };

  return { metrics, count };
}
