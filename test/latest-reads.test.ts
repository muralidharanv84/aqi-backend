import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { handleLatest } from "../src/routes/latest";
import migration from "../db/migrations/0004_winix_monitor_lookup_index.sql?raw";
import schema from "../db/schema.sql?raw";
import { insertDevice, insertSample, resetDb } from "./utils/db";

describe("latest endpoint D1 read budget", () => {
  beforeEach(async () => {
    await resetDb(env.DB);
    for (const deviceId of ["active-monitor", "old-monitor", "outdoor"]) {
      await insertDevice(env.DB, deviceId, "secret");
      await insertSample(env.DB, deviceId, 1700000000, { pm25_ugm3: 10 });
    }
    await env.DB.prepare(`
      INSERT INTO winix_control_log (run_ts, run_status, monitor_device_id, created_ts)
      VALUES (1700000000, 'success', 'old-monitor', 1700000000)
    `).run();
    await env.DB.prepare(`
      WITH RECURSIVE seq(i) AS (
        SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < 1000
      )
      INSERT INTO winix_control_log (run_ts, run_status, monitor_device_id, created_ts)
      SELECT 1700000000 + i, 'success', 'active-monitor', 1700000000 + i FROM seq
    `).run();
  });

  // Capture the handler's actual SQL so this budget also checks future changes
  // to the lookup, instead of testing a separate copy of the production query.
  async function lookupReads(deviceId: string) {
    const prepare = vi.spyOn(env.DB, "prepare");
    let queries: string[];
    try {
      const response = await handleLatest(
        new Request(`https://example.com/api/v1/devices/${deviceId}/latest`),
        env,
        deviceId,
      );
      expect(response.status).toBe(200);
      const body = await response.json<{ fan_control: { latest_event: { run_ts: number } | null } }>();
      expect(body.fan_control.latest_event?.run_ts ?? null).toBe(
        deviceId === "outdoor" ? null : deviceId === "old-monitor" ? 1700000000 : 1700001000,
      );
      queries = prepare.mock.calls.map(([sql]) => sql);
    } finally {
      prepare.mockRestore();
    }
    const sql = queries.find((query) => query.includes("FROM winix_control_log"));
    expect(sql).toBeDefined();
    const result = await env.DB.prepare(sql!).bind(deviceId).all();
    return result.meta.rows_read;
  }

  it("eliminates full scans for missing and old monitors on existing databases", async () => {
    expect(await lookupReads("outdoor")).toBeGreaterThanOrEqual(1000);
    expect(await lookupReads("old-monitor")).toBeGreaterThanOrEqual(1000);

    await env.DB.prepare(migration).run();
    await env.DB.prepare(migration).run(); // Deployment retries are safe.

    for (const deviceId of ["outdoor", "old-monitor", "active-monitor"]) {
      expect(await lookupReads(deviceId)).toBeLessThanOrEqual(2);
    }
  });

  it("also includes the lookup index when initializing a new database", async () => {
    // Schema comments may contain semicolons; remove them before splitting.
    const statements = schema.replace(/--[^\n]*/g, "").split(";").map((sql) => sql.trim()).filter(Boolean);
    for (const statement of statements) await env.DB.prepare(statement).run();

    for (const deviceId of ["outdoor", "old-monitor", "active-monitor"]) {
      expect(await lookupReads(deviceId)).toBeLessThanOrEqual(2);
    }
  });
});
