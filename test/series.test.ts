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
      "https://example.com/api/v1/devices/device-a/series?metric=pm25_ugm3&from=0&to=60&resolution=17m",
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

  it("groups five-minute readings without counting missing metric values", async () => {
    await insertDevice(env.DB, "five-minute", "secret");
    await insertSample(env.DB, "five-minute", 60, { co2_ppm: 600 });
    await insertSample(env.DB, "five-minute", 120, { co2_ppm: 800 });
    await insertSample(env.DB, "five-minute", 180, { temp_c: 24 });
    await insertSample(env.DB, "five-minute", 300, { co2_ppm: 900 });
    const response = await SELF.fetch("https://example.com/api/v1/devices/five-minute/series?metric=co2_ppm&from=0&to=300&resolution=5m");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ resolution: "5m", points: [
      { ts: 0, avg: 700, min: 600, max: 800, n: 2 },
      { ts: 300, avg: 900, min: 900, max: 900, n: 1 },
    ] });
  });

  it("limits five-minute queries to the raw retention query range", async () => {
    const response = await SELF.fetch("https://example.com/api/v1/devices/a/series?metric=aqi_us&from=0&to=1209601&resolution=5m");
    expect(response.status).toBe(400);
  });

  it.each(["1d", "1w", "1mo"])("weights %s averages and retains extremes within the requested bounds", async (resolution) => {
    const start = Date.UTC(2024, 0, 1) / 1000; // Monday, also a month boundary.
    await insertDevice(env.DB, "aggregate", "secret");
    await insertDevice(env.DB, "other", "secret");
    // Exclude an earlier hour in the same calendar period and another device.
    await insertHourlySample(env.DB, "aggregate", start, {co2_avg: 9999, co2_min: 9999, co2_max: 9999}, 100);
    await insertHourlySample(env.DB, "other", start + 3600, {co2_avg: 9999}, 100);
    await insertHourlySample(env.DB, "aggregate", start + 3600, {co2_avg: 10, co2_min: 2, co2_max: 18}, 1);
    await insertHourlySample(env.DB, "aggregate", start + 7200, {co2_avg: 30, co2_min: 20, co2_max: 60}, 3);
    await insertHourlySample(env.DB, "aggregate", start + 10800, {temp_avg: 20}, 100);
    await insertHourlySample(env.DB, "aggregate", start + 14400, {co2_avg: 9999, co2_min: 9999, co2_max: 9999}, 0);
    const response = await SELF.fetch(`https://example.com/api/v1/devices/aggregate/series?metric=co2_ppm&from=${start + 3600}&to=${start + 14400}&resolution=${resolution}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({resolution, points: [{ts: start, avg: 25, min: 2, max: 60, n: 4}]});
  });

  it("starts weekly buckets on Monday across year boundaries", async () => {
    await insertDevice(env.DB, "weekly", "secret");
    const sunday = Date.UTC(2023, 11, 31, 23) / 1000;
    const monday = Date.UTC(2024, 0, 1) / 1000;
    await insertHourlySample(env.DB, "weekly", sunday, {aqi_avg: 40, aqi_min: 30, aqi_max: 50});
    await insertHourlySample(env.DB, "weekly", monday, {aqi_avg: 70, aqi_min: 60, aqi_max: 80});
    const response = await SELF.fetch(`https://example.com/api/v1/devices/weekly/series?metric=aqi_us&from=${sunday}&to=${monday}&resolution=1w`);
    const body = await response.json() as HourlySeries;
    expect(body.points.map(p => [p.ts, p.avg])).toEqual([
      [Date.UTC(2023, 11, 25) / 1000, 40], [monday, 70],
    ]);
  });

  it("uses calendar months across leap days", async () => {
    await insertDevice(env.DB, "monthly", "secret");
    const leapDay = Date.UTC(2024, 1, 29, 23) / 1000;
    const march = Date.UTC(2024, 2, 1) / 1000;
    await insertHourlySample(env.DB, "monthly", leapDay, {aqi_avg: 40});
    await insertHourlySample(env.DB, "monthly", march, {aqi_avg: 70});
    const response = await SELF.fetch(`https://example.com/api/v1/devices/monthly/series?metric=aqi_us&from=${leapDay}&to=${march}&resolution=1mo`);
    const body = await response.json() as HourlySeries;
    expect(body.points.map(p => p.ts)).toEqual([Date.UTC(2024, 1, 1) / 1000, march]);
  });

  it("chooses All time resolution from device history consistently across metrics", async () => {
    await insertDevice(env.DB, "history", "secret");
    await insertHourlySample(env.DB, "history", Date.UTC(2026, 0, 1) / 1000, {aqi_avg: 40});
    await insertHourlySample(env.DB, "history", Date.UTC(2026, 1, 1) / 1000, {aqi_avg: 50, co2_avg: 700});
    for (const metric of ["aqi_us", "co2_ppm"]) {
      const response = await SELF.fetch(`https://example.com/api/v1/devices/history/series?metric=${metric}&from=0&to=${Date.UTC(2026, 8, 15) / 1000}&resolution=auto`);
      expect(await response.json()).toMatchObject({resolution: "1d"});
    }
  });

  it("returns empty points for empty aggregate history", async () => {
    const response = await SELF.fetch("https://example.com/api/v1/devices/missing/series?metric=aqi_us&from=0&to=2000000000&resolution=auto");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({resolution: "1h", points: []});
  });
});
