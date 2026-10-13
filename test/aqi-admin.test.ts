import { describe, it, expect, vi } from "vitest";
import { handleRequest } from "../src/index";
import type { Env } from "../src/env";

function env() {
  const fetch = vi.fn(async () => Response.json({ configured: true }));
  return { fetch, env: { AQI_ADMIN_KEY: "operator-test-secret", AQI_SESSION: { idFromName: (name: string) => name, get: () => ({ fetch }) } } as unknown as Env };
}
const url = "https://example.com/internal/aqi/";
describe("AQI operator API", () => {
  it("rejects anonymous or incorrect credentials without contacting the session", async () => {
    const t = env();
    for (const headers of [new Headers(), new Headers({ Authorization: "Bearer wrong" })]) {
      expect((await handleRequest(new Request(url + "status", { headers }), t.env)).status).toBe(401);
    }
    expect(t.fetch).not.toHaveBeenCalled();
  });
  it("allows only explicit AQI-origin preflight and protects the actual action", async () => {
    const t = env();
    const preflight = await handleRequest(new Request(url + "session", { method: "OPTIONS", headers: { Origin: "https://dash.aqi.in" } }), t.env);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe("https://dash.aqi.in");
    const bad = await handleRequest(new Request(url + "session", { method: "OPTIONS", headers: { Origin: "https://evil.example" } }), t.env);
    expect(bad.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect((await handleRequest(new Request(url + "session", { method: "POST", headers: { Origin: "https://dash.aqi.in" } }), t.env)).status).toBe(401);
  });
  it("returns uncached status and rejects malformed seed bodies", async () => {
    const t = env(); const headers = { Authorization: "Bearer operator-test-secret" };
    const status = await handleRequest(new Request(url + "status", { headers }), t.env);
    expect(status.headers.get("Cache-Control")).toBe("no-store");
    expect(await status.json()).toEqual({ configured: true });
    expect((await handleRequest(new Request(url + "session", { method: "POST", headers, body: "broken" }), t.env)).status).toBe(400);
    expect((await handleRequest(new Request(url + "refresh", { headers }), t.env)).status).toBe(405);
    expect((await handleRequest(new Request(url + "unknown", { method: "POST", headers }), t.env)).status).toBe(404);
  });
});
