import { METRIC_FIELDS, type MetricField } from "./metrics";

export type SeriesResolution = "raw" | "1h";

const ALLOWED_RESOLUTIONS = new Set<SeriesResolution>(["raw", "1h"]);

const METRIC_SET = new Set<string>(METRIC_FIELDS);

const HOURLY_COLUMN_MAP: Record<
  MetricField,
  { avg: string; min: string; max: string }
> = {
  pm25_ugm3: { avg: "pm25_avg", min: "pm25_min", max: "pm25_max" },
  aqi_us: { avg: "aqi_avg", min: "aqi_min", max: "aqi_max" },
  co2_ppm: { avg: "co2_avg", min: "co2_min", max: "co2_max" },
  voc_ppm: { avg: "voc_ppm_avg", min: "voc_ppm_min", max: "voc_ppm_max" },
  voc_index: { avg: "voc_index_avg", min: "voc_index_min", max: "voc_index_max" },
  temp_c: { avg: "temp_avg", min: "temp_min", max: "temp_max" },
  rh_pct: { avg: "rh_avg", min: "rh_min", max: "rh_max" },
};

export function parseSeriesQuery(url: URL): {
  metric: MetricField;
  resolution: SeriesResolution;
  from: number;
  to: number;
} | { error: string } {
  const metric = url.searchParams.get("metric");
  const resolution = url.searchParams.get("resolution");
  const fromRaw = url.searchParams.get("from");
  const toRaw = url.searchParams.get("to");

  if (!metric || !METRIC_SET.has(metric)) return { error: "Invalid metric" };
  if (!resolution || !ALLOWED_RESOLUTIONS.has(resolution as SeriesResolution)) {
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

  return {
    metric: metric as MetricField,
    resolution: resolution as SeriesResolution,
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
