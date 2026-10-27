import { MUTHANALLUR, readBounded, type AqiReading, type Fetch } from "./client";

const HOST = "https://airquality.aqi.in/api/v1/";
export class AqiAuthError extends Error {
  constructor(public readonly code: string) { super(code); }
}
export class AqiUpstreamError extends Error {}

export function tokenExpiry(token: string): number {
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, "=")));
    if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) throw 0;
    return claims.exp * 1000;
  } catch { throw new AqiAuthError("invalid_token_format"); }
}

async function api(path: string, token: string, request: Fetch, method = "GET"): Promise<any> {
  let response: Response;
  try {
    response = await request(HOST + path, {
      method, redirect: "manual", signal: AbortSignal.timeout(12_000),
      headers: { Accept: "application/json", Authorization: `bearer ${token}`, serialno: MUTHANALLUR.uid },
    });
  } catch { throw new AqiUpstreamError("aqi_network_failure"); }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403) throw new AqiAuthError("auth_rejected");
    throw new AqiUpstreamError(`aqi_http_${response.status}`);
  }
  let data: any;
  try { data = JSON.parse(await readBounded(response)); }
  catch { throw new AqiUpstreamError("aqi_invalid_response"); }
  if (data && data.status === 0 && /token|unauth|unauthor|login|credential|access denied/i.test(String(data.msg ?? data.message ?? ""))) {
    throw new AqiAuthError("auth_rejected");
  }
  if (data?.status === 0 && /no device|permission/i.test(String(data.msg ?? data.message ?? ""))) {
    throw new AqiAuthError("device_access_missing");
  }
  return data;
}

export async function renewToken(token: string, now: number, request: Fetch = fetch): Promise<string> {
  const data = await api("refresh", token, request, "POST");
  if (typeof data?.token !== "string" || tokenExpiry(data.token) <= now + 60_000) {
    throw new AqiAuthError("renewal_invalid_response");
  }
  return data.token;
}

/** This integration is specifically for the Bangalore monitor: no ambiguous host timezone parsing. */
export function observationTime(value: unknown, timezone: unknown, now: number): string {
  if (timezone !== "Asia/Kolkata" && timezone !== "Asia/Calcutta") throw new AqiUpstreamError("unexpected_device_timezone");
  const m = typeof value === "string" && /^(\d{4})-(\d{2})-(\d{2}) (\d{1,2}):(\d{2}):(\d{2}) (AM|PM)$/.exec(value);
  if (!m) throw new AqiUpstreamError("invalid_device_timestamp");
  const [, y, mo, d, h, mi, s, period] = m;
  if (+h < 1 || +h > 12 || +mi > 59 || +s > 59 || +mo < 1 || +mo > 12 || +d < 1 || +d > 31) throw new AqiUpstreamError("invalid_device_timestamp");
  const hour = +h % 12 + (period === "PM" ? 12 : 0);
  const local = Date.UTC(+y, +mo - 1, +d, hour, +mi, +s);
  const date = new Date(local);
  if (date.getUTCFullYear() !== +y || date.getUTCMonth() !== +mo - 1 || date.getUTCDate() !== +d) throw new AqiUpstreamError("invalid_device_timestamp");
  const utc = local - 330 * 60_000;
  if (utc > now + 60_000) throw new AqiUpstreamError("future_device_timestamp");
  return new Date(utc).toISOString();
}

export function parseRealtime(data: any, now: number): AqiReading {
  if (data?.status !== 1 || !Array.isArray(data.data)) throw new AqiUpstreamError("device_response_unsuccessful");
  const devices = data.data.filter((d: any) => d?.serialNo === MUTHANALLUR.uid);
  if (devices.length !== 1) throw new AqiAuthError("device_access_missing");
  const device = devices[0];
  if (![0, 1].includes(device.isOnline) || !Array.isArray(device.realtime)) throw new AqiUpstreamError("invalid_device_readings");
  function metric(id: number, unit: string, required = false): number | null {
    const matches = device.realtime.filter((m: any) => m?.sensorid === id);
    if (!matches.length && !required) return null;
    if (matches.length !== 1) throw new AqiUpstreamError("missing_or_duplicate_sensor");
    const m = matches[0];
    const actualUnit = String(m.unit).replace(/μ/g, "µ");
    if (actualUnit !== unit || typeof m.sensorvalue !== "number" || !Number.isFinite(m.sensorvalue) ||
        (id !== 11 && m.sensorvalue < 0) || (id === 12 && m.sensorvalue > 100) ||
        (id === 11 && (m.sensorvalue < -80 || m.sensorvalue > 100))) throw new AqiUpstreamError("invalid_sensor_value_or_unit");
    return m.sensorvalue;
  }
  return {
    ...MUTHANALLUR, observedAt: observationTime(device.last_updated, device.device_timezone, now),
    fetchedAt: new Date(now).toISOString(), online: device.isOnline === 1,
    metrics: { pm25_ugm3: metric(3, "µg/m³", true)!, pm10_ugm3: metric(4, "µg/m³"),
      noise_db: metric(13, "dB"), tvoc_ppm: metric(18, "ppm"), temp_c: metric(11, "°C"), rh_pct: metric(12, "%") },
  };
}

export async function fetchRealtime(token: string, now: number, request: Fetch = fetch): Promise<AqiReading> {
  return parseRealtime(await api("GetSingleUserDevicesDetails", token, request), now);
}

/** Thrown when login answers with a shape we do not recognize. Carries field names only, never values. */
export class AqiLoginShapeError extends AqiUpstreamError {
  constructor(public readonly fields: string[]) { super("login_unexpected_response"); }
}
/** AQI refused the sign-in. `detail` is AQI's own message with emails and tokens removed, for operator diagnosis. */
export class AqiLoginRejected extends AqiAuthError {
  constructor(code: string, public readonly httpStatus: number, public readonly detail: string,
    public readonly fields: string[]) { super(code); }
}

const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const sanitize = (text: unknown) => String(text ?? "")
  .replace(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[token]")
  .replace(/[^\s@"']+@[^\s@"']+/g, "[email]").slice(0, 160);
function rejected(data: any, httpStatus: number): AqiLoginRejected {
  const msg = data?.msg ?? data?.message ?? data?.error ?? "";
  const errors = data?.errors && typeof data.errors === "object" ? data.errors : {};
  const detail = sanitize(typeof msg === "string" ? msg : JSON.stringify(msg)) ||
    sanitize(Object.values(errors).flat().join(" "));
  const code = /pass ?key/i.test(detail) ? "login_passkey_required" : "login_rejected";
  return new AqiLoginRejected(code, httpStatus, detail, Object.keys(errors).slice(0, 20));
}

/**
 * Email/password sign-in for an AQI account. Starts a brand-new session, so it also resets
 * the 14-day renewal window that bearer refresh cannot extend. Never logs or returns the password.
 */
export async function login(email: string, password: string, now: number, request: Fetch = fetch): Promise<string> {
  let response: Response;
  try {
    response = await request(HOST + "login", {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(12_000),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
  } catch { throw new AqiUpstreamError("aqi_network_failure"); }
  const rejection = [400, 401, 403, 422].includes(response.status);
  if (!response.ok && !rejection) { await response.body?.cancel(); throw new AqiUpstreamError(`aqi_http_${response.status}`); }
  let data: any;
  try { data = response.body ? JSON.parse(await readBounded(response)) : null; }
  catch { if (rejection) throw rejected(null, response.status); throw new AqiUpstreamError("aqi_invalid_response"); }
  if (rejection) throw rejected(data, response.status);
  const candidates = [data?.token, data?.access_token, data?.data?.token, data?.data?.access_token, data?.data?.user?.token];
  const token = candidates.find((t): t is string => typeof t === "string" && JWT_SHAPE.test(t));
  if (!token) {
    if (data?.status === 0 || data?.status === false || data?.success === false) throw rejected(data, response.status);
    const fields = Object.keys(data ?? {}).concat(Object.keys(data?.data ?? {}).map(k => `data.${k}`));
    throw new AqiLoginShapeError(fields.slice(0, 30));
  }
  if (tokenExpiry(token) <= now + 60_000) throw new AqiAuthError("login_invalid_response");
  return token;
}
