import { beforeEach, describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import { insertDevice, resetDb } from "./utils/db";

type DevicesResponse = {
  devices: Array<{ device_id: string; timezone: string }>;
};

describe("devices endpoint", () => {
  beforeEach(async () => {
    await resetDb(env.DB);
  });

  it("rejects non-GET methods", async () => {
    const res = await SELF.fetch("https://example.com/api/v1/devices", {
      method: "POST",
    });

    expect(res.status).toBe(405);
  });

  it("returns devices with id and timezone", async () => {
    await insertDevice(env.DB, "device-a", "secret-a", "Asia/Kolkata");
    await insertDevice(env.DB, "device-b", "secret-b", "UTC");

    const res = await SELF.fetch("https://example.com/api/v1/devices");
    expect(res.status).toBe(200);

    const body = (await res.json()) as DevicesResponse;
    expect(body.devices).toEqual([
      { device_id: "device-a", timezone: "Asia/Kolkata" },
      { device_id: "device-b", timezone: "UTC" },
    ]);
  });
});
