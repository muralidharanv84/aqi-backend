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

  it("adds CORS headers for Cloudflare Pages origins", async () => {
    const baseRes = await SELF.fetch("https://example.com/api/v1/health", {
      headers: { Origin: "https://aqi-web.pages.dev" },
    });

    expect(baseRes.headers.get("Access-Control-Allow-Origin"))
      .toBe("https://aqi-web.pages.dev");

    const previewRes = await SELF.fetch("https://example.com/api/v1/health", {
      headers: { Origin: "https://preview-123.aqi-web.pages.dev" },
    });

    expect(previewRes.headers.get("Access-Control-Allow-Origin"))
      .toBe("https://preview-123.aqi-web.pages.dev");
  });

  it("does not add CORS headers for disallowed origins", async () => {
    const res = await SELF.fetch("https://example.com/api/v1/health", {
      headers: { Origin: "http://preview-123.aqi-web.pages.dev" },
    });

    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
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
