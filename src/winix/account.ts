import { COGNITO_CLIENT_SECRET_KEY } from "./constants";
import type {
  StoredWinixAuthState,
  WinixDeviceSummary,
  WinixResolvedSession,
} from "./types";

const WINIX_MOBILE_BASE = "https://us.mobile.winix-iot.com";

type WinixApiDevice = {
  deviceId: string;
  deviceAlias?: string;
  modelName?: string;
};

type WinixApiBaseResponse = {
  resultCode?: string;
  resultMessage?: string;
};

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) {
      c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0 ^ -1;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function decodeJwtSub(token: string): string {
  const parts = token.split(".");
  if (parts.length < 2) throw new Error("Invalid JWT token");

  const payloadB64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = payloadB64.padEnd(
    payloadB64.length + ((4 - (payloadB64.length % 4)) % 4),
    "=",
  );
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  const payload = JSON.parse(new TextDecoder().decode(bytes)) as { sub?: string };
  if (!payload.sub) throw new Error("JWT token missing sub claim");
  return payload.sub;
}

function buildWinixUuid(accessToken: string): string {
  const userId = decodeJwtSub(accessToken);
  const p1 = crc32(utf8(`github.com/hfern/winixctl${userId}`));
  const p2 = crc32(utf8(`HGF${userId}`));
  return `${p1.toString(16).padStart(8, "0")}${p2.toString(16).padStart(8, "0")}`;
}

async function postWinixJson<TResponse extends Record<string, unknown>>(
  path: string,
  payload: Record<string, unknown>,
): Promise<TResponse> {
  const response = await fetch(`${WINIX_MOBILE_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = (await response.json()) as TResponse;
  if (!response.ok) {
    throw new Error(
      `Winix API ${path} failed (${response.status}): ${JSON.stringify(data)}`,
    );
  }
  return data;
}

function assertSuccess(path: string, response: WinixApiBaseResponse): void {
  if (response.resultCode && response.resultCode !== "200") {
    throw new Error(
      `Winix API ${path} returned code=${response.resultCode} message=${response.resultMessage ?? ""}`,
    );
  }
}

async function registerUser(
  accessToken: string,
  username: string,
  uuid: string,
): Promise<void> {
  const response = await postWinixJson<WinixApiBaseResponse>("/registerUser", {
    cognitoClientSecretKey: COGNITO_CLIENT_SECRET_KEY,
    accessToken,
    uuid,
    email: username,
    osType: "android",
    osVersion: "29",
    mobileLang: "en",
  });
  assertSuccess("/registerUser", response);
}

async function checkAccessToken(
  accessToken: string,
  uuid: string,
): Promise<void> {
  const response = await postWinixJson<WinixApiBaseResponse>("/checkAccessToken", {
    cognitoClientSecretKey: COGNITO_CLIENT_SECRET_KEY,
    accessToken,
    uuid,
    osVersion: "29",
    mobileLang: "en",
  });
  assertSuccess("/checkAccessToken", response);
}

type DeviceListResponse = WinixApiBaseResponse & {
  deviceInfoList?: WinixApiDevice[];
};

async function getDeviceInfoList(
  accessToken: string,
  uuid: string,
): Promise<WinixApiDevice[]> {
  const response = await postWinixJson<DeviceListResponse>("/getDeviceInfoList", {
    accessToken,
    uuid,
  });
  assertSuccess("/getDeviceInfoList", response);
  return response.deviceInfoList ?? [];
}

export interface WinixAccountHandle {
  getDevices(): Promise<WinixApiDevice[]>;
}

export interface WinixAccountProvider {
  fromAuth(
    username: string,
    auth: StoredWinixAuthState,
  ): Promise<WinixAccountHandle>;
}

export const defaultWinixAccountProvider: WinixAccountProvider = {
  async fromAuth(
    username: string,
    auth: StoredWinixAuthState,
  ): Promise<WinixAccountHandle> {
    const uuid = buildWinixUuid(auth.accessToken);
    await registerUser(auth.accessToken, username, uuid);
    await checkAccessToken(auth.accessToken, uuid);

    return {
      getDevices: () => getDeviceInfoList(auth.accessToken, uuid),
    };
  },
};

export async function resolveWinixSession(
  username: string,
  auth: StoredWinixAuthState,
  provider: WinixAccountProvider = defaultWinixAccountProvider,
): Promise<WinixResolvedSession> {
  const account = await provider.fromAuth(username, auth);
  const devices = await account.getDevices();

  const mapped: WinixDeviceSummary[] = devices
    .map((device) => ({
      deviceId: device.deviceId,
      alias: device.deviceAlias ?? null,
      model: device.modelName ?? null,
    }))
    .filter((device) => Boolean(device.deviceId));

  return { auth, devices: mapped };
}
