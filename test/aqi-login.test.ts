import { describe, expect, it, vi } from "vitest";
import { AqiSessionManager, EXPIRY_WARNING_WINDOW, LOGIN_RETRY_INTERVAL, type SessionState } from "../src/aqi-in/session";
import { login } from "../src/aqi-in/realtime";
import { NOW, jwt, payload } from "./utils/aqi";
import { MUTHANALLUR } from "../src/aqi-in/client";

const LOGIN_URL = "https://airquality.aqi.in/api/v1/login";
const PASSWORD = "correct horse battery staple";
const DAY = 86_400_000;
/** Device reports its reading at the current test time, as IST wall time with AM/PM. */
function deviceAt(now: number) {
  const d = new Date(now + 330 * 60_000), p = (n: number) => String(n).padStart(2, "0");
  const h = d.getUTCHours(), h12 = h % 12 || 12;
  const body = payload();
  body.data[0].last_updated = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(h12)}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ${h < 12 ? "AM" : "PM"}`;
  return body;
}
type LoginMode = "ok" | "nested" | "wrong" | "shape" | "down";

function setup(opts: { creds?: boolean; login?: LoginMode; padded?: boolean } = {}) {
  const map = new Map<string, any>();
  const storage = { get: async <T>(key: string) => structuredClone(map.get(key)) as T | undefined,
    put: async <T>(key: string, value: T) => { map.set(key, structuredClone(value)); } };
  const live = new Set<string>(); // tokens AQI currently accepts for device reads
  let clock = NOW, refreshClosed = false, loginMode: LoginMode = opts.login ?? "ok", n = 0;
  const notify = vi.fn().mockResolvedValue(undefined);
  const auth = (init?: RequestInit) => String((init?.headers as any)?.Authorization ?? "").replace(/^bearer /, "");
  const request = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.endsWith("/refresh")) {
      if (refreshClosed) return Response.json({ status: 0, msg: "Token has expired and can no longer be refreshed" }, { status: 401 });
      live.delete(auth(init)); const t = jwt(NOW + 28 * DAY, `renewed${n++}`); live.add(t); return Response.json({ token: t });
    }
    if (url === LOGIN_URL) {
      if (loginMode === "down") return new Response(null, { status: 503 });
      if (loginMode === "wrong") return Response.json({ status: 0, msg: "Invalid email or password" });
      if (loginMode === "shape") return Response.json({ status: 1, user: { id: 1 } });
      const t = jwt(NOW + 120 * DAY, `login${n++}`); live.add(t);
      return Response.json(loginMode === "nested" ? { status: 1, data: { token: t } } : { status: 1, token: t, token_type: "bearer" });
    }
    if (url.includes("GetSingleUserDevicesDetails")) {
      return live.has(auth(init)) ? Response.json(deviceAt(clock)) : Response.json({ status: 0, msg: "Token is Invalid" });
    }
    if (url.includes("auth/login")) return new Response(JSON.stringify({ siteStore: { token2: jwt(NOW + 40 * DAY) } }));
    return Response.json({ status: "success", data: [{ uid: MUTHANALLUR.uid, location_slug: MUTHANALLUR.slug,
      isOnline: true, updatedAt: "2026-10-13T03:51:23Z", iaqi: { pm25: 60, pm10: 70, noise: 48, tvoc: 34.374 } }] });
  });
  const creds = opts.creds === false ? {} : opts.padded ? { email: " owner@example.com\n", password: PASSWORD + "\n" }
    : { email: "owner@example.com", password: PASSWORD };
  const inner = new AqiSessionManager(storage, notify, request, creds);
  const manager = { read: (at: number) => { clock = at; return inner.read(at); }, seed: inner.seed.bind(inner),
    status: inner.status.bind(inner), verifyLogin: (at: number) => { clock = at; return inner.verifyLogin(at); } };
  const seed = async (exp = NOW + 28 * DAY) => { const t = jwt(exp, "seed"); live.add(t); await manager.seed(t, NOW); return t; };
  const logins = () => request.mock.calls.filter(([url]) => url === LOGIN_URL);
  const state = () => map.get("aqi-session-v1") as SessionState;
  return { manager, notify, request, seed, logins, state, live,
    closeRefresh: () => { refreshClosed = true; }, setLogin: (m: LoginMode) => { loginMode = m; } };
}

describe("AQI password sign-in and renewal-window handling", () => {
  it("keeps using a token whose renewal is refused, warns before expiry, then falls back", async () => {
    const t = setup({ creds: false }); const seeded = await t.seed(NOW + 10 * DAY); t.closeRefresh();
    expect((await t.manager.read(NOW + DAY + 1000))?.source).toBe("private"); // daily renewal refused
    expect(t.state()).toMatchObject({ token: seeded, refreshClosed: true, authFailures: 0 });
    expect((await t.manager.read(NOW + 2 * DAY))?.source).toBe("private");
    expect(t.request.mock.calls.filter(([u]) => u.endsWith("/refresh"))).toHaveLength(1); // no retry storm
    expect(t.notify).not.toHaveBeenCalled();
    const warnAt = NOW + 10 * DAY - EXPIRY_WARNING_WINDOW + 1000;
    await t.manager.read(warnAt); await t.manager.read(warnAt + 60_000);
    expect(t.notify).toHaveBeenCalledTimes(1);
    expect(t.notify.mock.calls[0][0]).toContain("expires soon");
    await t.manager.read(warnAt + DAY); expect(t.notify).toHaveBeenCalledTimes(2);
    expect((await t.manager.read(NOW + 10 * DAY))?.source).toBe("public");
  });

  it("signs in with the password when renewal is refused and resumes normal renewal", async () => {
    const t = setup(); await t.seed(); t.closeRefresh();
    expect((await t.manager.read(NOW + DAY + 1000))?.source).toBe("private");
    expect(t.logins()).toHaveLength(1);
    expect(JSON.parse(String(t.logins()[0][1]?.body))).toEqual({ email: "owner@example.com", password: PASSWORD });
    expect(t.state().token).toMatch(/login/);
    expect(t.state().refreshClosed).toBeUndefined();
    const status = JSON.stringify(await t.manager.status());
    expect(status).not.toContain(PASSWORD); expect(status).not.toContain(t.state().token!);
    expect(await t.manager.status()).toMatchObject({ passwordLoginConfigured: true, authFailures: 0 });
  });

  it("ignores whitespace around stored credentials", async () => {
    const t = setup({ padded: true }); await t.manager.read(NOW);
    expect(JSON.parse(String(t.logins()[0][1]?.body))).toEqual({ email: "owner@example.com", password: PASSWORD });
  });

  it("recovers automatically when there is no usable session at all", async () => {
    const t = setup({ login: "nested" });
    expect((await t.manager.read(NOW))?.source).toBe("private");
    expect(t.state()).toMatchObject({ lastLogin: NOW, authFailures: 0 });
  });

  it("recovers from a revoked token by signing in again", async () => {
    const t = setup(); const seeded = await t.seed(); t.live.delete(seeded); t.closeRefresh();
    expect((await t.manager.read(NOW + 1000))?.source).toBe("private");
    expect(t.logins()).toHaveLength(1);
  });

  it("throttles failed sign-ins and alerts without ever including the password", async () => {
    const t = setup({ login: "wrong" });
    for (let m = 0; m <= 20; m++) await t.manager.read(NOW + m * 60_000);
    expect(t.logins()).toHaveLength(1);
    expect(t.state().loginError).toBe("login_rejected");
    expect(t.notify).toHaveBeenCalledTimes(1);
    expect(t.notify.mock.calls[0][1]).toContain("password sign-in also failed: login_rejected");
    await t.manager.read(NOW + LOGIN_RETRY_INTERVAL); expect(t.logins()).toHaveLength(2);
    t.setLogin("ok"); await t.manager.read(NOW + 2 * LOGIN_RETRY_INTERVAL);
    expect(await t.manager.status()).toMatchObject({ configured: true, authFailures: 0 });
    for (const [subject, body] of t.notify.mock.calls) expect(subject + body).not.toContain(PASSWORD);
    expect(JSON.stringify(await t.manager.status())).not.toContain(PASSWORD);
  });

  it("verifies sign-in without changing stored state and reports unknown response shapes by field name", async () => {
    const t = setup(); await t.seed(); const before = structuredClone(t.state());
    const ok = await t.manager.verifyLogin(NOW);
    expect(ok).toMatchObject({ loginOk: true, deviceMatched: true, validityMinutes: 120 * 24 * 60 });
    expect(JSON.stringify(ok)).not.toMatch(/login\d|seed/);
    expect(t.state()).toEqual(before);
    t.setLogin("shape");
    expect(await t.manager.verifyLogin(NOW)).toMatchObject({ loginOk: false, error: "login_unexpected_response", responseFields: ["status", "user"] });
    t.setLogin("wrong");
    expect(await t.manager.verifyLogin(NOW)).toMatchObject({ loginOk: false, error: "login_rejected" });
    expect(await setup({ creds: false }).manager.verifyLogin(NOW)).toEqual({ passwordLoginConfigured: false });
    const echoed = await login("a@b.c", "x", NOW, async () => Response.json({ message: "The given data was invalid.",
      errors: { email: ["owner@example.com is not registered"] } }, { status: 422 })).catch(e => e);
    expect(echoed).toMatchObject({ code: "login_rejected", httpStatus: 422, detail: "The given data was invalid.", fields: ["email"] });
    const t2 = setup({ login: "wrong" });
    const diag = await t2.manager.verifyLogin(NOW);
    expect(diag).toMatchObject({ loginOk: false, httpStatus: 200, detail: "Invalid email or password" });
    expect(JSON.stringify(diag)).not.toContain(PASSWORD);
  });

  it("treats outages as upstream errors, not bad passwords", async () => {
    const t = setup({ login: "down" });
    await t.manager.read(NOW);
    expect(t.state().loginError).toBe("aqi_http_503");
    await expect(login("a@b.c", "x", NOW, async () => new Response(null, { status: 401 }))).rejects.toThrow("login_rejected");
    await expect(login("a@b.c", "x", NOW, async () => Response.json({ status: 0, msg: "Please enter pass key" }))).rejects.toThrow("login_passkey_required");
  });
});
