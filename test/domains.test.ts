import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";

describe("production domain migration", () => {
  it("serves the new API with CORS for the new dashboard", async () => {
    const res = await SELF.fetch("https://aqi-backend.murali.page/api/v1/health", {
      headers: { Origin: "https://aqi.murali.page" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://aqi.murali.page");
    expect(res.headers.get("Location")).toBeNull();
  });

  it.each(["GET", "POST"])("permanently redirects %s preserving the URL", async (method) => {
    const res = await SELF.fetch("https://aqi-backend.orangeiqlabs.com/api/v1/ingest?probe=a%2Fb&x=1", {
      method,
      redirect: "manual",
      headers: { Origin: "https://aqi.orangeiqlabs.com", "Content-Type": "application/json" },
      ...(method === "POST" ? { body: "{}" } : {}),
    });
    expect(res.status).toBe(308);
    expect(res.headers.get("Location")).toBe("https://aqi-backend.murali.page/api/v1/ingest?probe=a%2Fb&x=1");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://aqi.orangeiqlabs.com");
  });

  it("answers legacy preflight without redirecting", async () => {
    const res = await SELF.fetch("https://aqi-backend.orangeiqlabs.com/api/v1/ingest", {
      method: "OPTIONS",
      headers: { Origin: "https://aqi.murali.page", "Access-Control-Request-Method": "POST" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Location")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://aqi.murali.page");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("X-Signature");
  });
});
