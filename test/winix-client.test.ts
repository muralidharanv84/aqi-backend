import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WinixAuth } from "winix-api";
import { env, fetchMock } from "cloudflare:test";
import { Buffer } from "node:buffer";
import { encrypt } from "winix-api/dist/account/winix-crypto";
import { createWinixControlClient, resolveWinixAuthState } from "../src/winix/client";
import { runWinixControlLoop } from "../src/cron/winixControl";
import { insertDevice, insertSample, resetDb } from "./utils/db";

const identityId = "us-east-1:11111111-1111-1111-1111-111111111111";
const accessToken = `${Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify({ sub: "user-1" })).toString("base64url")}.signature`;

describe("Winix protocol in the Worker runtime", () => {
  beforeEach(async () => {
    vi.spyOn(WinixAuth, "login").mockRejectedValue(new Error("Unexpected full login"));
    fetchMock.activate();
    fetchMock.disableNetConnect();
    await resetDb(env.DB);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fetchMock.assertNoPendingInterceptors();
    fetchMock.deactivate();
  });

  it.each([false, true])("uses the encrypted handshake and identity in commands (rejected=%s)", async (rejected) => {
    const nowTs = Math.floor(Date.now() / 1000);
    await insertDevice(env.DB, "monitor-1", "secret");
    for (const age of [60, 120, 180]) {
      await insertSample(env.DB, "monitor-1", nowTs - age, { pm25_ugm3: 33 });
    }
    await env.DB.prepare(`INSERT INTO winix_auth_state
      (id, user_id, access_token, id_token, refresh_token, access_expires_at, updated_ts)
      VALUES (1, ?, ?, ?, ?, ?, ?)`)
      .bind("user-1", accessToken, "id-token", "refresh-token", nowTs + 3600, nowTs).run();

    const calls: string[] = [];
    fetchMock.get("https://cognito-identity.us-east-1.amazonaws.com")
      .intercept({ path: "/", method: "POST" })
      .reply(200, (request) => {
        const body = JSON.parse(String(request.body));
        expect(body.Logins["cognito-idp.us-east-1.amazonaws.com/us-east-1_Ofd50EosD"]).toBe("id-token");
        calls.push("identity");
        return { IdentityId: identityId };
      });

    for (const path of ["/registerUser", "/init", "/checkAccessToken", "/getDeviceInfoList"]) {
      fetchMock.get("https://us.mobile.winix-iot.com")
        .intercept({ path, method: "POST", headers: { "content-type": "application/octet-stream" } })
        .reply(200, () => {
          calls.push(path);
          return encrypt({ resultCode: "200", deviceInfoList: [{ deviceId: "purifier-1" }, { deviceId: "purifier-2" }] });
        }, { headers: { "content-type": "application/octet-stream" } });
    }

    for (const deviceId of ["purifier-1", "purifier-2"]) {
      fetchMock.get("https://us.api.winix-iot.com")
        .intercept({ path: `/common/event/sttus/devices/${deviceId}`, method: "GET" })
        .reply(200, { headers: { resultMessage: "success" }, body: { data: [{ attributes: { A02: "0", A03: "01", A04: "01" } }] } });
      for (const command of ["A02:1", "A03:02", "A04:05"]) {
        fetchMock.get("https://us.api.winix-iot.com")
          .intercept({ path: `/common/control/devices/${deviceId}/${identityId}/${command}`, method: "GET" })
          .reply(200, () => {
            calls.push(`${deviceId}/${command}`);
            return { headers: { resultMessage: rejected && deviceId === "purifier-1" && command === "A04:05" ? "device not connected" : "success" } };
          });
      }
    }

    const result = await runWinixControlLoop({
      DB: env.DB,
      WINIX_CONTROL_ENABLED: "true",
      WINIX_DRY_RUN: "false",
      WINIX_USERNAME: "user@example.com",
      WINIX_PASSWORD: "password",
      WINIX_MONITOR_DEVICE_ID: "monitor-1",
    }, nowTs * 1000);

    expect(calls).toEqual([
      "identity", "/registerUser", "/init", "/checkAccessToken", "/getDeviceInfoList",
      "purifier-1/A02:1", "purifier-1/A03:02", "purifier-1/A04:05",
      "purifier-2/A02:1", "purifier-2/A03:02", "purifier-2/A04:05",
    ]);
    expect(result.status).toBe(rejected ? "error" : "success");
    const row = await env.DB.prepare("SELECT run_status, error_message FROM winix_control_log ORDER BY id DESC LIMIT 1")
      .first<{ run_status: string; error_message: string | null }>();
    expect(row?.run_status).toBe(result.status);
    if (rejected) expect(row?.error_message).toContain("device not connected");
    else expect(row?.error_message).toBeNull();
  });

  it("requires a resolved session before sending commands", async () => {
    await expect(createWinixControlClient().setAirflow("purifier-1", "high"))
      .rejects.toThrow("session has not been resolved");
  });

  it("refreshes with the current public Cognito client and persists expiry in seconds", async () => {
    const nowTs = Math.floor(Date.now() / 1000);
    fetchMock.get("https://cognito-idp.us-east-1.amazonaws.com")
      .intercept({ path: "/", method: "POST" })
      .reply(200, (request) => {
        const body = JSON.parse(String(request.body));
        expect(body.ClientId).toBe("5rjk59c5tt7k9g8gpj0vd2qfg9");
        expect(body.AuthParameters).toEqual({ REFRESH_TOKEN: "refresh-token" });
        return { AuthenticationResult: { AccessToken: accessToken, IdToken: "new-id-token", ExpiresIn: 3600 } };
      });

    const auth = await resolveWinixAuthState("user@example.com", "password", {
      userId: "user-1", accessToken, refreshToken: "refresh-token", accessExpiresAt: nowTs,
    }, nowTs);

    expect(auth.idToken).toBe("new-id-token");
    expect(auth.accessExpiresAt).toBeGreaterThanOrEqual(nowTs + 3600);
    expect(auth.accessExpiresAt).toBeLessThanOrEqual(nowTs + 3605);
    expect(WinixAuth.login).not.toHaveBeenCalled();
  });
});
