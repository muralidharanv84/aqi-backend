import { afterEach, describe, expect, it, vi } from "vitest";
import { AqiSessionManager, type SessionState } from "../src/aqi-in/session";
import { AqiSession } from "../src/aqi-in/durable";
import { NOW, jwt, payload } from "./utils/aqi";
import { MUTHANALLUR } from "../src/aqi-in/client";
import type { Env } from "../src/env";

function setup() {
  const map = new Map<string, any>();
  const storage = { get: async <T>(key: string) => structuredClone(map.get(key)) as T | undefined,
    put: async <T>(key: string, value: T) => { map.set(key, structuredClone(value)); } };
  let revoked = false, outage = false, fallbackDown = false, refreshLost = false;
  const tokens: string[] = [];
  const notify = vi.fn().mockResolvedValue(undefined);
  const request = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.endsWith("/refresh")) {
      if (refreshLost) throw new Error("PRIVATE SECRET NETWORK BODY");
      if (revoked) return Response.json({ status: 0, msg: "Token is Invalid" });
      const token = jwt(NOW + 30 * 86400_000, `renewed${tokens.length}`); tokens.push(token);
      return Response.json({ token });
    }
    if (url.includes("GetSingleUserDevicesDetails")) {
      if (outage) return new Response(null, { status: 503 });
      if (revoked) return Response.json({ status: 0, msg: "Token is Invalid" });
      return Response.json(payload());
    }
    if (fallbackDown) return new Response(null, { status: 503 });
    if (url.includes("auth/login")) return new Response(JSON.stringify({ siteStore: { token2: jwt(NOW + 40 * 86400_000) } }));
    return Response.json({ status: "success", data: [{ uid: MUTHANALLUR.uid, location_slug: MUTHANALLUR.slug,
      isOnline: true, updatedAt: "2026-10-13T03:51:23Z", iaqi: { pm25: 60, pm10: 70, noise: 48, tvoc: 34.374 } }] });
  });
  const manager = new AqiSessionManager(storage, notify, request);
  return { manager, map, storage, notify, request, tokens,
    revoke: () => { revoked = true; }, recover: () => { revoked = false; },
    outage: () => { outage = true; }, fallbackDown: () => { fallbackDown = true; }, lost: () => { refreshLost = true; } };
}

describe("AQI session persistence, fallback and notifications", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("seeds only after verifying device access and never exposes credentials in status", async () => {
    const t = setup(); await t.manager.seed(jwt(), NOW);
    expect(await t.manager.read(NOW)).toMatchObject({ source: "private", reading: { metrics: { temp_c: 25.4, rh_pct: 64 } } });
    expect(JSON.stringify(await t.manager.status())).not.toContain(jwt());
    t.revoke(); await expect(t.manager.seed(jwt(NOW + 86400_000, "bad"), NOW)).rejects.toThrow();
    expect((t.map.get("aqi-session-v1") as SessionState).token).toBe(jwt());
  });
  it("renews, persists replacements and uses the latest token on the next renewal", async () => {
    const t = setup(); await t.manager.seed(jwt(), NOW);
    await t.manager.refresh(NOW + 1000); await t.manager.refresh(NOW + 2000);
    const calls = t.request.mock.calls.filter(([url]) => url.endsWith("/refresh"));
    expect((calls[0][1]?.headers as any).Authorization).toBe(`bearer ${jwt()}`);
    expect((calls[1][1]?.headers as any).Authorization).toBe(`bearer ${t.tokens[0]}`);
    expect(t.map.get("aqi-session-v1").token).toBe(t.tokens[1]);
    const restarted = new AqiSessionManager(t.storage, t.notify, t.request);
    await restarted.read(NOW + 3000);
    expect((t.request.mock.calls.at(-1)?.[1]?.headers as any).Authorization).toBe(`bearer ${t.tokens[1]}`);
  });
  it("automatically renews when due", async () => {
    const t = setup(); await t.manager.seed(jwt(NOW + 120_000), NOW);
    await t.manager.read(NOW + 61_000);
    expect(t.tokens).toHaveLength(1);
  });
  it("falls back immediately, throttles public requests, and does not reuse revoked tokens", async () => {
    const t = setup(); await t.manager.seed(jwt(), NOW); t.revoke();
    const result = await t.manager.read(NOW); expect(result?.source).toBe("public");
    expect(result?.reading.observedAt).toBe("2026-10-13T03:51:23.000Z");
    const calls = t.request.mock.calls.length;
    expect(await t.manager.read(NOW + 60_000)).toBeNull(); expect(t.request.mock.calls).toHaveLength(calls);
    expect(await t.manager.status()).toMatchObject({ configured: false, authFailures: 2 });
    expect(t.notify).not.toHaveBeenCalled();
  });
  it("reserves token rotation before sending and never retries an ambiguous renewal", async () => {
    const t = setup(); await t.manager.seed(jwt(), NOW); t.lost();
    await expect(t.manager.refresh(NOW + 1)).rejects.toThrow("renewal_outcome_unknown");
    const restarted = new AqiSessionManager(t.storage, t.notify, t.request);
    expect((await restarted.read(NOW + 60_000))?.source).toBe("public");
    expect(t.request.mock.calls.filter(([url]) => url.endsWith("/refresh"))).toHaveLength(1);
    expect(JSON.stringify(await restarted.status())).not.toContain("PRIVATE SECRET");
  });
  it("recovers a persisted pending refresh after a crash without replaying its token", async () => {
    const t = setup(); await t.manager.seed(jwt(), NOW);
    t.map.get("aqi-session-v1").rotationPending = true;
    expect((await t.manager.read(NOW))?.source).toBe("public");
    expect(t.tokens).toHaveLength(0);
  });
  it("uses public data during transient outages without sending auth alerts", async () => {
    const t = setup(); await t.manager.seed(jwt(), NOW); t.outage();
    expect((await t.manager.read(NOW))?.source).toBe("public");
    await t.manager.read(NOW + 16 * 60_000);
    expect(await t.manager.status()).toMatchObject({ configured: true, authFailures: 0 });
    expect(t.notify).not.toHaveBeenCalled();
  });
  it("emails after sustained failure, daily while failing, and stops on successful reseeding", async () => {
    const t = setup();
    for (const offset of [0, 60_000, 15 * 60_000, 16 * 60_000, 23 * 3600_000]) await t.manager.read(NOW + offset);
    expect(t.notify).toHaveBeenCalledTimes(1);
    await t.manager.read(NOW + 25 * 3600_000); expect(t.notify).toHaveBeenCalledTimes(2);
    await t.manager.seed(jwt(), NOW + 26 * 3600_000);
    await t.manager.read(NOW + 27 * 3600_000); // Stale sensor data still proves auth works.
    expect(t.notify).toHaveBeenCalledTimes(2);
    expect(await t.manager.status()).toMatchObject({ authFailures: 0 });
  });
  it("does not suppress the alert if public data also fails, or spam on ambiguous mail failure", async () => {
    const t = setup(); t.fallbackDown(); t.notify.mockRejectedValue(new Error("mail timeout"));
    for (const offset of [0, 60_000, 15 * 60_000, 16 * 60_000, 20 * 60_000]) await t.manager.read(NOW + offset);
    expect(t.notify).toHaveBeenCalledTimes(1);
    expect(await t.manager.status()).toMatchObject({ authFailures: 5 });
  });
  it("serializes concurrent Durable Object renewals", async () => {
    const t = setup(); await t.manager.seed(jwt(), NOW);
    vi.stubGlobal("fetch", t.request);
    const object = new AqiSession({ storage: t.storage } as DurableObjectState, {} as Env);
    const [a, b] = await Promise.all([object.fetch(new Request("https://session/refresh")), object.fetch(new Request("https://session/refresh"))]);
    expect(a.status).toBe(200); expect(b.status).toBe(200);
    const calls = t.request.mock.calls.filter(([url]) => url.endsWith("/refresh"));
    expect(calls).toHaveLength(2);
    expect((calls[1][1]?.headers as any).Authorization).toBe(`bearer ${t.tokens[0]}`);
  });
});
