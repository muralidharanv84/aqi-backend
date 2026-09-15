import { METRIC_FIELDS, type MetricField } from "./metrics";

export type SeriesResolution = "raw" | "5m" | "1h" | "1d" | "1w" | "1mo";
export type SeriesResolutionRequest = SeriesResolution | "auto";

const ALLOWED_RESOLUTIONS = new Set<SeriesResolutionRequest>(["raw", "5m", "1h", "1d", "1w", "1mo", "auto"]);
const MAX_RAW_RANGE_SECONDS = 14 * 24 * 60 * 60;

export function chooseAggregateResolution(from: number, to: number): Exclude<SeriesResolution, "raw" | "5m"> {
  const days = (to - from) / 86400;
  if (days <= 14) return "1h";
  if (days <= 90) return "1d";
  if (days <= 730) return "1w";
  return "1mo";
}

// Calendar boundaries are UTC; weeks start on Monday. Only trusted SQL fragments
// from this map and the metric allowlist are interpolated into queries.
export function aggregateBucketSql(resolution: Exclude<SeriesResolution, "raw" | "5m" | "1h">): string {
  const modifiers = {
    "1d": "'start of day'",
    "1w": "'-6 days', 'weekday 1', 'start of day'",
    "1mo": "'start of month'",
  };
  return `CAST(strftime('%s', hour_ts, 'unixepoch', ${modifiers[resolution]}) AS INTEGER)`;
}

const METRIC_SET = new Set<string>(METRIC_FIELDS);

const HOURLY_COLUMN_MAP: Record<
  MetricField,
  { avg: string; min: string; max: string }
> = {
  pm25_ugm3: { avg: "pm25_avg", min: "pm25_min", max: "pm25_max" },
  pm10_ugm3: { avg: "pm10_avg", min: "pm10_min", max: "pm10_max" },
  noise_db: { avg: "noise_avg", min: "noise_min", max: "noise_max" },
  aqi_us: { avg: "aqi_avg", min: "aqi_min", max: "aqi_max" },
  co2_ppm: { avg: "co2_avg", min: "co2_min", max: "co2_max" },
  voc_ppm: { avg: "voc_ppm_avg", min: "voc_ppm_min", max: "voc_ppm_max" },
  voc_index: { avg: "voc_index_avg", min: "voc_index_min", max: "voc_index_max" },
  temp_c: { avg: "temp_avg", min: "temp_min", max: "temp_max" },
  rh_pct: { avg: "rh_avg", min: "rh_min", max: "rh_max" },
};

export function parseSeriesQuery(url: URL): {
  metric: MetricField;
  resolution: SeriesResolutionRequest;
  from: number;
  to: number;
} | { error: string } {
  const metric = url.searchParams.get("metric");
  const resolution = url.searchParams.get("resolution");
  const fromRaw = url.searchParams.get("from");
  const toRaw = url.searchParams.get("to");

  if (!metric || !METRIC_SET.has(metric)) return { error: "Invalid metric" };
  if (!resolution || !ALLOWED_RESOLUTIONS.has(resolution as SeriesResolutionRequest)) {
    return { error: "Invalid resolution" };
  }
  if (!fromRaw || !toRaw) return { error: "Missing time bounds" };

  const from = Number(fromRaw);
  const to = Number(toRaw);

  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    return { error: "Invalid time bounds" };
  }
  if (!Number.isInteger(from) || !Number.isInteger(to)) {
    return { error: "Invalid time bounds" };
  }
  if (from > to) return { error: "Invalid time bounds" };

  if ((resolution === "raw" || resolution === "5m") && to - from > MAX_RAW_RANGE_SECONDS) {
    return { error: resolution === "raw" ? "Raw range too large" : "5m range too large" };
  }

  return {
    metric: metric as MetricField,
    resolution: resolution as SeriesResolutionRequest,
    from,
    to,
  };
}

export function hourlyColumns(metric: MetricField): {
  avg: string;
  min: string;
  max: string;
} {
  return HOURLY_COLUMN_MAP[metric];
}
