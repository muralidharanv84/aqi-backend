import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

type PingResponse = { ok: number; now: string };
type HealthResponse = { ok: boolean };

describe("AQI backend worker", () => {
  it("responds with healthcheck JSON", async () => {
    const res = await SELF.fetch("https://example.com/api/v1/health");
    expect(res.status).toBe(200);

    const body = (await res.json()) as HealthResponse;
    expect(body.ok).toBe(true);
  });

  it("adds CORS headers for allowed origin", async () => {
    const res = await SELF.fetch("https://example.com/api/v1/health", {
      headers: { Origin: "https://aqi.orangeiqlabs.com" },
    });

    expect(res.headers.get("Access-Control-Allow-Origin"))
      .toBe("https://aqi.orangeiqlabs.com");
    expect(res.headers.get("Vary")).toBe("Origin");
  });

  it("handles OPTIONS preflight", async () => {
    const res = await SELF.fetch("https://example.com/api/v1/health", {
      method: "OPTIONS",
      headers: { Origin: "https://aqi.orangeiqlabs.com" },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin"))
      .toBe("https://aqi.orangeiqlabs.com");
  });

  it("responds with DB ping JSON on root", async () => {
    const res = await SELF.fetch("https://example.com/");
    expect(res.status).toBe(200);

    const body = (await res.json()) as PingResponse;
    expect(body.ok).toBe(1);
    expect(typeof body.now).toBe("string");
  });
});
