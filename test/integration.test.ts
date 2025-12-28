import { beforeEach, describe, expect, it, vi } from "vitest";
import { env, SELF } from "cloudflare:test";
import { aggregateCompletedHours } from "../src/cron/aggregate";
import { signBody } from "./utils/auth";
import { insertDevice, resetDb } from "./utils/db";

type LatestResponse = {
  device_id: string;
  ts: number;
  metrics: Record<string, number>;
};

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

type HourlyRow = {
  hour_ts: number;
  pm25_avg: number | null;
  pm25_min: number | null;
  pm25_max: number | null;
  n: number;
};

describe("ingest + latest + series + aggregation integration", () => {
  beforeEach(async () => {
    await resetDb(env.DB);
  });

  it("ingests samples and serves latest/series consistently", async () => {
    const deviceId = "device-integration";
    const secret = "integration-secret";
    await insertDevice(env.DB, deviceId, secret);

    const nowSpy = vi.spyOn(Date, "now");
    try {
      nowSpy.mockReturnValue(1700000000123);
      const body1 = JSON.stringify({ pm25_ugm3: 12.5 });
      const sig1 = await signBody(secret, body1);
      const ingest1 = await SELF.fetch("https://example.com/api/v1/ingest", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Device-Id": deviceId,
          "X-Signature": sig1,
        },
        body: body1,
      });
      expect(ingest1.status).toBe(200);

      nowSpy.mockReturnValue(1700000060123);
      const body2 = JSON.stringify({ pm25_ugm3: 13.1, co2_ppm: 705 });
      const sig2 = await signBody(secret, body2);
      const ingest2 = await SELF.fetch("https://example.com/api/v1/ingest", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Device-Id": deviceId,
          "X-Signature": sig2,
        },
        body: body2,
      });
      expect(ingest2.status).toBe(200);
    } finally {
      nowSpy.mockRestore();
    }

    const latestRes = await SELF.fetch(
      `https://example.com/api/v1/devices/${deviceId}/latest`,
    );
    expect(latestRes.status).toBe(200);
    const latest = (await latestRes.json()) as LatestResponse;
    expect(latest.device_id).toBe(deviceId);
    expect(latest.ts).toBe(1700000040);
    expect(latest.metrics).toEqual({ pm25_ugm3: 13.1, co2_ppm: 705 });

    const seriesRes = await SELF.fetch(
      `https://example.com/api/v1/devices/${deviceId}/series?metric=pm25_ugm3&from=1699999000&to=1700001000&resolution=raw`,
    );
    expect(seriesRes.status).toBe(200);
    const series = (await seriesRes.json()) as RawSeries;
    expect(series.metric).toBe("pm25_ugm3");
    expect(series.resolution).toBe("raw");
    expect(series.points).toEqual([
      { ts: 1699999980, value: 12.5 },
      { ts: 1700000040, value: 13.1 },
    ]);

    await aggregateCompletedHours(env, 1700003000000);
    const hourly = await env.DB
      .prepare(
        "SELECT hour_ts, pm25_avg, pm25_min, pm25_max, n FROM samples_hourly WHERE device_id = ?",
      )
      .bind(deviceId)
      .first<HourlyRow>();

    expect(hourly?.hour_ts).toBe(1699999200);
    expect(hourly?.pm25_avg).toBe(12.8);
    expect(hourly?.pm25_min).toBe(12.5);
    expect(hourly?.pm25_max).toBe(13.1);
    expect(hourly?.n).toBe(2);

    const deviceId2 = "device-hours";
    const secret2 = "hours-secret";
    await insertDevice(env.DB, deviceId2, secret2);

    const nowSpy2 = vi.spyOn(Date, "now");
    try {
      nowSpy2.mockReturnValue(Date.UTC(2024, 0, 1, 1, 10, 0));
      const bodyA = JSON.stringify({ pm25_ugm3: 11 });
      const sigA = await signBody(secret2, bodyA);
      await SELF.fetch("https://example.com/api/v1/ingest", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Device-Id": deviceId2,
          "X-Signature": sigA,
        },
        body: bodyA,
      });

      nowSpy2.mockReturnValue(Date.UTC(2024, 0, 1, 1, 40, 0));
      const bodyB = JSON.stringify({ pm25_ugm3: 15 });
      const sigB = await signBody(secret2, bodyB);
      await SELF.fetch("https://example.com/api/v1/ingest", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Device-Id": deviceId2,
          "X-Signature": sigB,
        },
        body: bodyB,
      });

      nowSpy2.mockReturnValue(Date.UTC(2024, 0, 1, 2, 5, 0));
      const bodyC = JSON.stringify({ pm25_ugm3: 14 });
      const sigC = await signBody(secret2, bodyC);
      await SELF.fetch("https://example.com/api/v1/ingest", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Device-Id": deviceId2,
          "X-Signature": sigC,
        },
        body: bodyC,
      });

      nowSpy2.mockReturnValue(Date.UTC(2024, 0, 1, 2, 55, 0));
      const bodyD = JSON.stringify({ pm25_ugm3: 16 });
      const sigD = await signBody(secret2, bodyD);
      await SELF.fetch("https://example.com/api/v1/ingest", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Device-Id": deviceId2,
          "X-Signature": sigD,
        },
        body: bodyD,
      });
    } finally {
      nowSpy2.mockRestore();
    }

    await aggregateCompletedHours(env, Date.UTC(2024, 0, 1, 2, 10, 0));
    await aggregateCompletedHours(env, Date.UTC(2024, 0, 1, 3, 10, 0));

    const hourlySeriesRes = await SELF.fetch(
      `https://example.com/api/v1/devices/${deviceId2}/series?metric=pm25_ugm3&from=${
        Date.UTC(2024, 0, 1, 0, 0, 0) / 1000
      }&to=${Date.UTC(2024, 0, 1, 4, 0, 0) / 1000}&resolution=1h`,
    );
    expect(hourlySeriesRes.status).toBe(200);
    const hourlySeries = (await hourlySeriesRes.json()) as HourlySeries;
    expect(hourlySeries.metric).toBe("pm25_ugm3");
    expect(hourlySeries.resolution).toBe("1h");
    expect(hourlySeries.points).toEqual([
      { ts: Date.UTC(2024, 0, 1, 1, 0, 0) / 1000, avg: 13, min: 11, max: 15, n: 2 },
      { ts: Date.UTC(2024, 0, 1, 2, 0, 0) / 1000, avg: 15, min: 14, max: 16, n: 2 },
    ]);
  });
});
