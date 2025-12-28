import { beforeEach, describe, expect, it, vi } from "vitest";
import { env, SELF } from "cloudflare:test";
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

describe("ingest + latest + series integration", () => {
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
      `https://example.com/api/v1/devices/${deviceId}/series?metric=pm25_ugm3&from=0&to=2000000000&resolution=raw`,
    );
    expect(seriesRes.status).toBe(200);
    const series = (await seriesRes.json()) as RawSeries;
    expect(series.metric).toBe("pm25_ugm3");
    expect(series.resolution).toBe("raw");
    expect(series.points).toEqual([
      { ts: 1699999980, value: 12.5 },
      { ts: 1700000040, value: 13.1 },
    ]);
  });
});
