import { beforeEach, describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import { insertDevice, resetDb } from "./utils/db";

async function signBody(secret: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("ingest endpoint", () => {
  beforeEach(async () => {
    await resetDb(env.DB);
  });

  it("rejects missing auth headers", async () => {
    const res = await SELF.fetch("https://example.com/api/v1/ingest", {
      method: "POST",
      body: JSON.stringify({ pm25_ugm3: 10 }),
    });

    expect(res.status).toBe(401);
  });

  it("rejects unknown fields", async () => {
    const deviceId = "device-1";
    const secret = "secret-1";
    await insertDevice(env.DB, deviceId, secret);

    const body = JSON.stringify({ nope: 1 });
    const signature = await signBody(secret, body);

    const res = await SELF.fetch("https://example.com/api/v1/ingest", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Device-Id": deviceId,
        "X-Signature": signature,
      },
      body,
    });

    expect(res.status).toBe(400);
  });

  it("rejects invalid signature", async () => {
    const deviceId = "device-4";
    const secret = "secret-4";
    await insertDevice(env.DB, deviceId, secret);

    const body = JSON.stringify({ pm25_ugm3: 12.3 });
    const res = await SELF.fetch("https://example.com/api/v1/ingest", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Device-Id": deviceId,
        "X-Signature": "deadbeef",
      },
      body,
    });

    expect(res.status).toBe(401);
  });

  it("requires at least one metric", async () => {
    const deviceId = "device-2";
    const secret = "secret-2";
    await insertDevice(env.DB, deviceId, secret);

    const body = JSON.stringify({});
    const signature = await signBody(secret, body);

    const res = await SELF.fetch("https://example.com/api/v1/ingest", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Device-Id": deviceId,
        "X-Signature": signature,
      },
      body,
    });

    expect(res.status).toBe(400);
  });

  it("stores a valid sample", async () => {
    const deviceId = "device-3";
    const secret = "secret-3";
    await insertDevice(env.DB, deviceId, secret);

    const body = JSON.stringify({ pm25_ugm3: 18.2, aqi_us: 63 });
    const signature = await signBody(secret, body);

    const res = await SELF.fetch("https://example.com/api/v1/ingest", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Device-Id": deviceId,
        "X-Signature": signature,
      },
      body,
    });

    expect(res.status).toBe(200);
    const payload = (await res.json()) as { ok: boolean; ts: number };
    expect(payload.ok).toBe(true);
    expect(payload.ts % 60).toBe(0);

    const row = await env.DB
      .prepare("SELECT ts, pm25_ugm3, aqi_us FROM samples_raw WHERE device_id = ? AND ts = ?")
      .bind(deviceId, payload.ts)
      .first<{ ts: number; pm25_ugm3: number; aqi_us: number }>();

    expect(row?.ts).toBe(payload.ts);
    expect(row?.pm25_ugm3).toBe(18.2);
    expect(row?.aqi_us).toBe(63);
  });
});
