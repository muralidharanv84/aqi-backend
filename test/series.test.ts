import { beforeEach, describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import { insertDevice, insertHourlySample, insertSample, resetDb } from "./utils/db";

type RawSeries = {
  metric: string;
  resolution: string;
  points: Array<{ ts: number; value: number }>;
};

type HourlySeries = {
  metric: string;
  resolution: string;
  points: Array<{ ts: number; avg: number; min: number; max: number; n: number }>;
};

describe("series endpoint", () => {
  beforeEach(async () => {
    await resetDb(env.DB);
  });

  it("rejects non-GET methods", async () => {
    const res = await SELF.fetch(
      "https://example.com/api/v1/devices/device-a/series?metric=pm25_ugm3&from=0&to=60&resolution=raw",
      { method: "POST" },
    );

    expect(res.status).toBe(405);
  });

  it("rejects invalid metric", async () => {
    const res = await SELF.fetch(
      "https://example.com/api/v1/devices/device-a/series?metric=nope&from=0&to=60&resolution=raw",
    );

    expect(res.status).toBe(400);
  });

  it("rejects invalid resolution", async () => {
    const res = await SELF.fetch(
      "https://example.com/api/v1/devices/device-a/series?metric=pm25_ugm3&from=0&to=60&resolution=5m",
    );

    expect(res.status).toBe(400);
  });

  it("rejects missing time bounds", async () => {
    const res = await SELF.fetch(
      "https://example.com/api/v1/devices/device-a/series?metric=pm25_ugm3&resolution=raw",
    );

    expect(res.status).toBe(400);
  });

  it("returns raw points for a metric", async () => {
    const deviceId = "device-raw";
    await insertDevice(env.DB, deviceId, "secret");
    await insertSample(env.DB, deviceId, 100, { pm25_ugm3: 1.1 });
    await insertSample(env.DB, deviceId, 160, { pm25_ugm3: 1.3 });
    await insertSample(env.DB, deviceId, 220, { co2_ppm: 700 });

    const res = await SELF.fetch(
      `https://example.com/api/v1/devices/${deviceId}/series?metric=pm25_ugm3&from=0&to=300&resolution=raw`,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as RawSeries;
    expect(body.metric).toBe("pm25_ugm3");
    expect(body.resolution).toBe("raw");
    expect(body.points).toEqual([
      { ts: 100, value: 1.1 },
      { ts: 160, value: 1.3 },
    ]);
  });

  it("rejects raw ranges greater than two weeks", async () => {
    const res = await SELF.fetch(
      "https://example.com/api/v1/devices/device-a/series?metric=pm25_ugm3&from=0&to=1209601&resolution=raw",
    );

    expect(res.status).toBe(400);
  });

  it("returns hourly rollups for a metric", async () => {
    const deviceId = "device-hourly";
    await insertDevice(env.DB, deviceId, "secret");
    await insertHourlySample(env.DB, deviceId, 3600, {
      co2_avg: 700,
      co2_min: 680,
      co2_max: 720,
    }, 58);
    await insertHourlySample(env.DB, deviceId, 7200, {
      co2_avg: 710,
      co2_min: 690,
      co2_max: 730,
    }, 60);

    const res = await SELF.fetch(
      `https://example.com/api/v1/devices/${deviceId}/series?metric=co2_ppm&from=0&to=10000&resolution=1h`,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as HourlySeries;
    expect(body.metric).toBe("co2_ppm");
    expect(body.resolution).toBe("1h");
    expect(body.points).toEqual([
      { ts: 3600, avg: 700, min: 680, max: 720, n: 58 },
      { ts: 7200, avg: 710, min: 690, max: 730, n: 60 },
    ]);
  });
});
