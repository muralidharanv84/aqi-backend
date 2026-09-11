import {
  Airflow,
  Mode,
  Power,
  WinixAccount,
  WinixAuth,
  WinixClient,
  type WinixAuthResponse,
} from "winix-api";

export type FanSpeed = "low" | "medium" | "high" | "turbo";

export interface StoredWinixAuthState {
  userId: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  // Older D1 rows predate the identity-pool handshake and have no ID token.
  idToken?: string | null;
}

export interface WinixResolvedSession {
  auth: StoredWinixAuthState;
  devices: Array<{ deviceId: string; alias: string | null; model: string | null }>;
}

export interface WinixControlClient {
  resolveSession(
    username: string,
    password: string,
    storedAuth: StoredWinixAuthState | null,
    nowSec: number,
  ): Promise<WinixResolvedSession>;
  getDeviceState(deviceId: string): Promise<{
    power: "on" | "off";
    mode: "manual" | "auto";
    airflow: FanSpeed | null;
  }>;
  setPowerOn(deviceId: string): Promise<void>;
  setModeManual(deviceId: string): Promise<void>;
  setAirflow(deviceId: string, speed: FanSpeed): Promise<void>;
}

export interface WinixAuthProvider {
  login(username: string, password: string): Promise<StoredWinixAuthState>;
  refresh(refreshToken: string, userId: string): Promise<StoredWinixAuthState>;
}

function fromApiAuth(auth: WinixAuthResponse): StoredWinixAuthState {
  return {
    userId: auth.userId,
    accessToken: auth.accessToken,
    refreshToken: auth.refreshToken,
    idToken: auth.idToken,
    accessExpiresAt: Math.floor(auth.expiresAt / 1000),
  };
}

const defaultAuthProvider: WinixAuthProvider = {
  login: async (username, password) => fromApiAuth(await WinixAuth.login(username, password)),
  refresh: async (refreshToken, userId) => fromApiAuth(await WinixAuth.refresh(refreshToken, userId)),
};

export async function resolveWinixAuthState(
  username: string,
  password: string,
  stored: StoredWinixAuthState | null,
  nowSec: number,
  provider: WinixAuthProvider = defaultAuthProvider,
): Promise<StoredWinixAuthState> {
  if (!stored) return provider.login(username, password);
  if (stored.idToken && stored.accessExpiresAt > nowSec + 10 * 60) return stored;

  try {
    return await provider.refresh(stored.refreshToken, stored.userId);
  } catch {
    // Refresh tokens issued for Winix's retired Cognito client cannot be reused.
    return provider.login(username, password);
  }
}

const AIRFLOW: Record<FanSpeed, Airflow> = {
  low: Airflow.Low,
  medium: Airflow.Medium,
  high: Airflow.High,
  turbo: Airflow.Turbo,
};

export function createWinixControlClient(): WinixControlClient {
  // A session belongs to one control cycle, never to the shared Worker isolate.
  let deviceClient: WinixClient | null = null;
  function requireDeviceClient(): WinixClient {
    if (!deviceClient) throw new Error("Winix session has not been resolved");
    return deviceClient;
  }

  async function establishSession(username: string, auth: StoredWinixAuthState) {
    if (!auth.idToken) throw new Error("Winix authentication did not return an ID token");
    const account = await WinixAccount.from(username, {
      userId: auth.userId,
      accessToken: auth.accessToken,
      refreshToken: auth.refreshToken,
      idToken: auth.idToken,
      expiresAt: auth.accessExpiresAt * 1000,
    });
    const devices = await account.getDevices();
    deviceClient = new WinixClient(account.getIdentityId());
    return {
      auth,
      devices: devices.filter((device) => device.deviceId).map((device) => ({
        deviceId: device.deviceId,
        alias: device.deviceAlias ?? null,
        model: device.modelName ?? null,
      })),
    };
  }

  return {
    async resolveSession(username, password, storedAuth, nowSec) {
      deviceClient = null;
      const auth = await resolveWinixAuthState(username, password, storedAuth, nowSec);
      try {
        return await establishSession(username, auth);
      } catch {
        const freshAuth = await resolveWinixAuthState(username, password, null, nowSec);
        return establishSession(username, freshAuth);
      }
    },
    async getDeviceState(deviceId) {
      const state = await requireDeviceClient().getDeviceStatus(deviceId);
      const speed = (Object.keys(AIRFLOW) as FanSpeed[]).find((key) => AIRFLOW[key] === state.airflow);
      return {
        power: state.power === Power.On ? "on" : "off",
        mode: state.mode === Mode.Manual ? "manual" : "auto",
        airflow: speed ?? null,
      };
    },
    async setPowerOn(deviceId) {
      await requireDeviceClient().setPower(deviceId, Power.On);
    },
    async setModeManual(deviceId) {
      await requireDeviceClient().setMode(deviceId, Mode.Manual);
    },
    async setAirflow(deviceId, speed) {
      await requireDeviceClient().setAirflow(deviceId, AIRFLOW[speed]);
    },
  };
}
