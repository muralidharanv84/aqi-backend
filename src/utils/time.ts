export function minuteBucketTimestamp(nowMs: number): number {
  const nowSeconds = Math.floor(nowMs / 1000);
  return Math.floor(nowSeconds / 60) * 60;
}

type DateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    getFormatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

function getDateParts(date: Date, timeZone: string): DateParts {
  const formatter = getFormatter(timeZone);
  const parts = formatter.formatToParts(date);
  const values: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") {
      values[part.type] = Number(part.value);
    }
  }

  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
}

function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = getDateParts(date, timeZone);
  const localAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return localAsUtc - date.getTime();
}

function localTimeToUtcMs(local: DateParts, timeZone: string): number {
  const utcGuess = new Date(
    Date.UTC(
      local.year,
      local.month - 1,
      local.day,
      local.hour,
      local.minute,
      local.second,
    ),
  );
  const offsetMs = getTimeZoneOffsetMs(utcGuess, timeZone);
  return utcGuess.getTime() - offsetMs;
}

export function lastCompletedHourWindow(
  nowMs: number,
  timeZone: string,
): { startTs: number; endTs: number } {
  const tz = isValidTimeZone(timeZone) ? timeZone : "UTC";
  const nowDate = new Date(nowMs);
  const nowParts = getDateParts(nowDate, tz);
  const localHourStartAsUtc =
    Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day, nowParts.hour, 0, 0) -
    3600 * 1000;
  const localBoundary = new Date(localHourStartAsUtc);

  const localParts: DateParts = {
    year: localBoundary.getUTCFullYear(),
    month: localBoundary.getUTCMonth() + 1,
    day: localBoundary.getUTCDate(),
    hour: localBoundary.getUTCHours(),
    minute: 0,
    second: 0,
  };

  const utcStartMs = localTimeToUtcMs(localParts, tz);
  const startTs = Math.floor(utcStartMs / 1000);
  return { startTs, endTs: startTs + 3600 };
}
