/** Unofficial public-location API used by AQI's own dashboard. */
export const MUTHANALLUR = {
  slug: "india/karnataka/bangalore/muthanallur",
  uid: "8CBFEA3754B4",
} as const;

const API_URL = "https://apiserver.aqi.in/aqi/v2/getLocationDetailsBySlug";
const DASHBOARD_URL = "https://dash.aqi.in/auth/login";
const MAX_RESPONSE_BYTES = 512 * 1024;

export interface AqiReading {
  uid: string;
  slug: string;
  observedAt: string;
  fetchedAt: string;
  online: boolean;
  metrics: {
    pm25_ugm3: number;
    pm10_ugm3: number | null;
    noise_db: number | null;
    tvoc_ppm: number | null;
  };
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBounded(response: Response): Promise<string> {
  if (!response.body) throw new Error("AQI returned an empty response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("AQI response exceeded 512 KiB");
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

/** Extract only the visitor token rendered in Next.js page data; never execute scripts. */
export function extractVisitorToken(html: string, nowMs: number): string {
  const decoded = html.replace(/\\"/g, '"');
  const match = decoded.match(
    /"siteStore"\s*:\s*\{[^{}]*?"token2"\s*:\s*"([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)"/,
  );
  if (!match) throw new Error("AQI visitor token missing; dashboard markup may have changed");
  const token = match[1];
  let claims: unknown;
  try {
    const segment = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    claims = JSON.parse(atob(segment.padEnd(Math.ceil(segment.length / 4) * 4, "=")));
  } catch {
    throw new Error("AQI returned an invalid visitor token");
  }
  // This checks expiry, not the JWT signature. The token comes directly from AQI over HTTPS.
  if (!record(claims) || typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) {
    throw new Error("AQI visitor token has no valid expiry");
  }
  if (claims.exp * 1000 <= nowMs + 60_000) {
    throw new Error("AQI published an expired visitor token; try again on the next poll");
  }
  return token;
}

function numeric(metrics: Record<string, unknown>, key: string, required = false): number | null {
  const value = metrics[key];
  if (value === undefined || value === null) {
    if (required) throw new Error(`AQI response missing ${key}`);
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`AQI response has invalid ${key}`);
  }
  return value;
}

export function parseReading(
  payload: unknown,
  target: { slug: string; uid: string },
  nowMs: number,
): AqiReading {
  if (!record(payload) || payload.status !== "success" || !Array.isArray(payload.data)) {
    throw new Error("AQI returned an unsuccessful data response");
  }
  const location: unknown = payload.data[0];
  if (!record(location) || location.uid !== target.uid || location.location_slug !== target.slug) {
    throw new Error("AQI response does not match the requested monitor");
  }
  if (!record(location.iaqi) || typeof location.isOnline !== "boolean") {
    throw new Error("AQI response is missing monitor readings or online status");
  }
  // updated_at is local wall time incorrectly suffixed with Z. updatedAt is actual UTC.
  if (typeof location.updatedAt !== "string" || !location.updatedAt.endsWith("Z")) {
    throw new Error("AQI response missing the UTC observation timestamp");
  }
  const timestamp = Date.parse(location.updatedAt);
  if (!Number.isFinite(timestamp) || timestamp > nowMs + 5 * 60_000) {
    throw new Error("AQI response has an invalid or future observation timestamp");
  }
  const pm25 = numeric(location.iaqi, "pm25", true)!;
  return {
    uid: target.uid,
    slug: target.slug,
    observedAt: new Date(timestamp).toISOString(),
    fetchedAt: new Date(nowMs).toISOString(),
    online: location.isOnline,
    metrics: {
      pm25_ugm3: pm25,
      pm10_ugm3: numeric(location.iaqi, "pm10"),
      noise_db: numeric(location.iaqi, "noise"),
      tvoc_ppm: numeric(location.iaqi, "tvoc"),
    },
  };
}

/** Two ordinary HTTPS GETs; no browser, account cookies, or saved credentials. */
export async function fetchAqiReading(
  target: { slug: string; uid: string } = MUTHANALLUR,
  options: { fetch?: Fetch; nowMs?: number } = {},
): Promise<AqiReading> {
  const request = options.fetch ?? fetch;
  const nowMs = options.nowMs ?? Date.now();
  const page = await request(DASHBOARD_URL, {
    headers: { Accept: "text/html", "Cache-Control": "no-cache" },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  if (!page.ok) {
    await page.body?.cancel();
    throw new Error(`AQI token bootstrap failed (HTTP ${page.status})`);
  }
  const token = extractVisitorToken(await readBounded(page), nowMs);
  const url = new URL(API_URL);
  url.searchParams.set("slug", target.slug);
  url.searchParams.set("type", String(target.slug.split("/").length));
  url.searchParams.set("source", "aqi-dashboard");
  const response = await request(url.toString(), {
    headers: { Accept: "application/json", Authorization: `bearer ${token}`, "Cache-Control": "no-cache" },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`AQI data request failed (HTTP ${response.status})`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(await readBounded(response));
  } catch {
    throw new Error("AQI data response was not valid bounded JSON");
  }
  return parseReading(payload, target, nowMs);
}
