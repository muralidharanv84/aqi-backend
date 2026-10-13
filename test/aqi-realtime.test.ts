import { describe, expect, it, vi } from "vitest";
import { fetchRealtime, observationTime, parseRealtime, renewToken } from "../src/aqi-in/realtime";
import { MUTHANALLUR } from "../src/aqi-in/client";

import { NOW, jwt, payload } from "./utils/aqi";

describe("authenticated AQI client", () => {
  it("maps device temperature/humidity and all existing pollutants using source IST time", () => {
    expect(parseRealtime(payload(), NOW)).toMatchObject({ uid: MUTHANALLUR.uid, observedAt: "2026-10-13T03:58:20.000Z", online: true,
      metrics: { pm25_ugm3: 62, pm10_ugm3: 76, temp_c: 25.4, rh_pct: 64, noise_db: 50, tvoc_ppm: 34.374 } });
  });
  it("handles midnight/noon, zero values and negative temperature", () => {
    expect(observationTime("2026-10-13 12:00:00 AM", "Asia/Kolkata", NOW)).toBe("2026-10-12T18:30:00.000Z");
    expect(observationTime("2026-10-12 12:00:00 PM", "Asia/Kolkata", NOW)).toBe("2026-10-12T06:30:00.000Z");
    const p = payload(); p.data[0].realtime.forEach(m => m.sensorvalue = m.sensorid === 11 ? -5 : 0);
    expect(parseRealtime(p, NOW).metrics).toMatchObject({ temp_c: -5, rh_pct: 0, pm25_ugm3: 0 });
  });
  it.each(["2026-02-30 09:28:20 AM", "2026-10-13 13:28:20 AM", "2026-10-13 09:60:20 AM", "2026-10-13 09:28:20", "2027-10-13 09:28:20 AM"])("rejects invalid or future timestamp %s", time => {
    expect(() => observationTime(time, "Asia/Kolkata", NOW)).toThrow();
  });
  it("rejects another device, bad units, humidity out of range, and duplicate sensors", () => {
    let p = payload(); p.data[0].serialNo = "another"; expect(() => parseRealtime(p, NOW)).toThrow("device_access_missing");
    p = payload(); p.data[0].realtime[0].unit = "aqi"; expect(() => parseRealtime(p, NOW)).toThrow();
    p = payload(); p.data[0].realtime[3].sensorvalue = 101; expect(() => parseRealtime(p, NOW)).toThrow();
    p = payload(); p.data[0].realtime.push(p.data[0].realtime[0]); expect(() => parseRealtime(p, NOW)).toThrow();
    expect(() => observationTime("2026-10-13 09:28:20 AM", "UTC", NOW)).toThrow();
  });
  it("accepts absent optional sensors and offline status", () => {
    const p = payload(); p.data[0].realtime = p.data[0].realtime.slice(0, 1); p.data[0].isOnline = 0;
    expect(parseRealtime(p, NOW)).toMatchObject({ online: false, metrics: { temp_c: null, rh_pct: null, noise_db: null } });
  });
  it("recognizes auth failures inside HTTP 200, without returning arbitrary upstream content", async () => {
    const request = vi.fn().mockResolvedValue(Response.json({ status: 0, msg: "Token is Invalid SECRET" }));
    await expect(fetchRealtime(jwt(), NOW, request)).rejects.toThrow(/^auth_rejected$/);
    expect(request.mock.calls[0][1]).toMatchObject({ redirect: "manual", headers: { serialno: MUTHANALLUR.uid } });
  });
  it("does not forward credentials on redirects, and distinguishes transient errors", async () => {
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { Location: "https://elsewhere.example" } }));
    await expect(fetchRealtime(jwt(), NOW, request)).rejects.toThrow("aqi_http_302"); expect(request).toHaveBeenCalledTimes(1);
    await expect(fetchRealtime(jwt(), NOW, async () => new Response(null, { status: 429 }))).rejects.toThrow("aqi_http_429");
    await expect(fetchRealtime(jwt(), NOW, async () => new Response(null, { status: 401 }))).rejects.toThrow("auth_rejected");
  });
  it("validates renewed token expiry", async () => {
    await expect(renewToken(jwt(), NOW, async () => Response.json({ token: jwt(NOW - 1) }))).rejects.toThrow("renewal_invalid_response");
    await expect(renewToken(jwt(), NOW, async () => Response.json({ token: jwt() }))).resolves.toBe(jwt());
  });
});
