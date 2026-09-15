import { describe, expect, it, vi } from "vitest";
import { extractVisitorToken, fetchAqiReading, MUTHANALLUR, parseReading } from "../src/aqi-in/client";

const nowMs = Date.parse("2026-09-15T03:30:00Z");
// Minimal fixture from the live response, with unrelated location/weather metadata removed.
const payload = {
  status: "success",
  data: [{
    uid: String(MUTHANALLUR.uid),
    location_slug: MUTHANALLUR.slug,
    isOnline: true,
    updatedAt: "2026-09-15T03:21:23.108Z",
    updated_at: "2026-09-15T08:51:23.000Z",
    iaqi: { pm25: 32, pm10: 39, aqi: 94, "AQI-IN": 53, noise: 50, tvoc: 34.374 },
    weather: { temp_c: 24.6, humidity: 68 },
  }],
};

function token(exp = nowMs / 1000 + 3600): string {
  return `e30.${btoa(JSON.stringify({ userID: 1, exp })).replace(/=/g, "")}.fixture`;
}

function html(): string {
  // Next.js serializes page data inside a quoted JavaScript string.
  return `<script>self.__next_f.push([1,${JSON.stringify(JSON.stringify({ siteStore: { token: "unused", token2: token() } }))}])</script>`;
}

describe("AQI public-location client", () => {
  it("bootstraps the visitor token without cookies and requests the exact monitor", async () => {
    const request = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(new Response(html()))
      .mockResolvedValueOnce(Response.json(payload));
    const result = await fetchAqiReading(MUTHANALLUR, { fetch: request, nowMs });
    expect(request).toHaveBeenCalledTimes(2);
    const [bootstrapUrl, bootstrapInit] = request.mock.calls[0];
    expect(bootstrapUrl).toBe("https://dash.aqi.in/auth/login");
    expect(new Headers(bootstrapInit?.headers).has("Cookie")).toBe(false);
    expect(new Headers(bootstrapInit?.headers).has("Authorization")).toBe(false);
    const [dataUrl, dataInit] = request.mock.calls[1];
    expect(new URL(dataUrl).searchParams.get("slug")).toBe(MUTHANALLUR.slug);
    expect(new URL(dataUrl).searchParams.get("type")).toBe("4");
    expect(new Headers(dataInit?.headers).get("Authorization")).toBe(`bearer ${token()}`);
    expect(dataInit?.redirect).toBe("manual");
    expect(result.observedAt).toBe("2026-09-15T03:21:23.108Z");
    expect(result.metrics).toEqual({ pm25_ugm3: 32, pm10_ugm3: 39, noise_db: 50, tvoc_ppm: 34.374 });
    expect(result.metrics).not.toHaveProperty("temp_c");
    expect(JSON.stringify(result)).not.toContain(token());
  });

  it("recognizes plain and escaped page data, and rejects expired visitor tokens", () => {
    expect(extractVisitorToken(html(), nowMs)).toBe(token());
    expect(extractVisitorToken(JSON.stringify({ siteStore: { token2: token() } }), nowMs)).toBe(token());
    expect(() => extractVisitorToken(JSON.stringify({ siteStore: { token2: token(nowMs / 1000 - 1) } }), nowMs)).toThrow("expired");
    expect(() => extractVisitorToken("<html>Challenge</html>", nowMs)).toThrow("token missing");
  });

  it("rejects another station even if the API returns success", () => {
    const changed = structuredClone(payload);
    changed.data[0].uid = "OTHER";
    expect(() => parseReading(changed, MUTHANALLUR, nowMs)).toThrow("does not match");
  });

  it("does not substitute the incorrectly labeled local-time field for UTC", () => {
    const { updatedAt: _, ...location } = payload.data[0];
    expect(() => parseReading({ ...payload, data: [location] }, MUTHANALLUR, nowMs)).toThrow("UTC observation timestamp");
  });

  it("preserves zero readings and distinguishes absent optional sensors", () => {
    const changed = { ...payload, data: [{ ...payload.data[0], iaqi: { pm25: 0, aqi: 0 } }] };
    const result = parseReading(changed, MUTHANALLUR, nowMs);
    expect(result.metrics.pm25_ugm3).toBe(0);
    expect(result.metrics).not.toHaveProperty("aqi_us");
    expect(result.metrics).not.toHaveProperty("aqi_in");
    expect(result.metrics.noise_db).toBeNull();
  });

  it("does not require or return provider AQI values", () => {
    const changed = { ...payload, data: [{ ...payload.data[0], iaqi: { pm25: 32, aqi: "invalid", "AQI-IN": 999 } }] };
    const result = parseReading(changed, MUTHANALLUR, nowMs);
    expect(result.metrics).toEqual({ pm25_ugm3: 32, pm10_ugm3: null, noise_db: null, tvoc_ppm: null });
  });

  it("rejects invalid sensor values and future timestamps", () => {
    const changed = structuredClone(payload);
    changed.data[0].iaqi.pm25 = -1;
    expect(() => parseReading(changed, MUTHANALLUR, nowMs)).toThrow("invalid pm25");
    changed.data[0].iaqi.pm25 = 32;
    changed.data[0].updatedAt = "2026-09-16T03:30:00Z";
    expect(() => parseReading(changed, MUTHANALLUR, nowMs)).toThrow("future observation");
  });

  it("retains the observation time and offline state for callers to assess freshness", () => {
    const changed = structuredClone(payload);
    changed.data[0].isOnline = false;
    const result = parseReading(changed, MUTHANALLUR, nowMs);
    expect(result.online).toBe(false);
    expect(result.observedAt).not.toBe(result.fetchedAt);
  });

  it.each([302, 401, 403, 429, 500])("fails cleanly on HTTP %s without retrying or exposing tokens", async status => {
    const request = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(new Response(html()))
      .mockResolvedValueOnce(new Response("private error details", { status }));
    await expect(fetchAqiReading(MUTHANALLUR, { fetch: request, nowMs })).rejects.toThrow(`AQI data request failed (HTTP ${status})`);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("stops on a failed bootstrap without requesting data", async () => {
    const request = vi.fn().mockResolvedValue(new Response("Challenge", { status: 403 }));
    await expect(fetchAqiReading(MUTHANALLUR, { fetch: request, nowMs })).rejects.toThrow("bootstrap failed (HTTP 403)");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("bounds response size before parsing page data", async () => {
    const request = vi.fn().mockResolvedValue(new Response("x".repeat(512 * 1024 + 1)));
    await expect(fetchAqiReading(MUTHANALLUR, { fetch: request, nowMs })).rejects.toThrow("exceeded 512 KiB");
  });
});
