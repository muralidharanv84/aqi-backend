import { beforeEach, describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import { insertDevice, insertSample, resetDb } from "./utils/db";

type LatestResponse = {
  device_id: string;
  ts: number;
  metrics: Record<string, number>;
};

describe("latest endpoint", () => {
  beforeEach(async () => {
    await resetDb(env.DB);
  });

  it("rejects non-GET methods", async () => {
    const res = await SELF.fetch("https://example.com/api/v1/devices/device-a/latest", {
      method: "POST",
    });

    expect(res.status).toBe(405);
  });

  it("returns 404 when no samples exist", async () => {
    const deviceId = "device-b";
    await insertDevice(env.DB, deviceId, "secret");

    const res = await SELF.fetch(
      `https://example.com/api/v1/devices/${deviceId}/latest`,
    );

    expect(res.status).toBe(404);
  });

  it("returns the most recent sample with metrics", async () => {
    const deviceId = "device-c";
    await insertDevice(env.DB, deviceId, "secret");

    await insertSample(env.DB, deviceId, 1700000000, { pm25_ugm3: 9.1 });
    await insertSample(env.DB, deviceId, 1700000060, {
      co2_ppm: 701,
      temp_c: 23.4,
    });

    const res = await SELF.fetch(
      `https://example.com/api/v1/devices/${deviceId}/latest`,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as LatestResponse;
    expect(body.device_id).toBe(deviceId);
    expect(body.ts).toBe(1700000060);
    expect(body.metrics).toEqual({ co2_ppm: 701, temp_c: 23.4 });
  });
});
