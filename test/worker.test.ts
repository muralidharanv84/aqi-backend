import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

type PingResponse = { ok: number; now: string };

describe("AQI backend worker", () => {
  it("responds with DB ping JSON", async () => {
    const res = await SELF.fetch("https://example.com/");
    expect(res.status).toBe(200);

    const body = (await res.json()) as PingResponse;
    expect(body.ok).toBe(1);
    expect(typeof body.now).toBe("string");
  });

  it("adds CORS headers for allowed origin", async () => {
    const res = await SELF.fetch("https://example.com/", {
      headers: { Origin: "https://aqi.orangeiqlabs.com" },
    });

    expect(res.headers.get("Access-Control-Allow-Origin"))
      .toBe("https://aqi.orangeiqlabs.com");
    expect(res.headers.get("Vary")).toBe("Origin");
  });

  it("handles OPTIONS preflight", async () => {
    const res = await SELF.fetch("https://example.com/", {
      method: "OPTIONS",
      headers: { Origin: "https://aqi.orangeiqlabs.com" },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin"))
      .toBe("https://aqi.orangeiqlabs.com");
  });
});