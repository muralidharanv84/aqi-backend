import {
  createWinixDeviceClient,
  resolveWinixAuthState,
  resolveWinixSession,
  type StoredWinixAuthState,
  type WinixDeviceClient,
  type WinixResolvedSession,
} from "winix-control-sdk";

export interface WinixControlClient extends WinixDeviceClient {
  resolveSession(
    username: string,
    password: string,
    storedAuth: StoredWinixAuthState | null,
    nowSec: number,
  ): Promise<WinixResolvedSession>;
}

export function createWinixControlClient(): WinixControlClient {
  // Keep the SDK's authenticated device client local to one control cycle.
  let deviceClient: WinixDeviceClient | null = null;
  function requireClient(): WinixDeviceClient {
    if (!deviceClient) throw new Error("Winix session has not been resolved");
    return deviceClient;
  }

  return {
    async resolveSession(username, password, storedAuth, nowSec) {
      deviceClient = null;
      let auth = await resolveWinixAuthState(username, password, storedAuth, nowSec);
      let session: WinixResolvedSession;
      try {
        session = await resolveWinixSession(username, auth);
      } catch {
        auth = await resolveWinixAuthState(username, password, null, nowSec);
        session = await resolveWinixSession(username, auth);
      }
      deviceClient = createWinixDeviceClient(session.identityId);
      return session;
    },
    getState: (deviceId) => requireClient().getState(deviceId),
    setPowerOn: (deviceId) => requireClient().setPowerOn(deviceId),
    setModeManual: (deviceId) => requireClient().setModeManual(deviceId),
    setAirflow: (deviceId, speed) => requireClient().setAirflow(deviceId, speed),
  };
}
