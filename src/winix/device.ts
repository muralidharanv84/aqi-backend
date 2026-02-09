import type { FanSpeed, WinixDeviceState } from "./types";

const STATE_URL =
  "https://us.api.winix-iot.com/common/event/sttus/devices/{deviceId}";
const CTRL_URL =
  "https://us.api.winix-iot.com/common/control/devices/{deviceId}/A211/{attribute}:{value}";

const ATTR_POWER = "A02";
const ATTR_MODE = "A03";
const ATTR_AIRFLOW = "A04";

const POWER_ON = "1";
const MODE_MANUAL = "02";

function airflowToSpeed(airflow: string | undefined): FanSpeed | null {
  switch (airflow) {
    case "01":
      return "low";
    case "02":
      return "medium";
    case "03":
      return "high";
    case "05":
      return "turbo";
    default:
      return null;
  }
}

function speedToAirflow(speed: FanSpeed): string {
  switch (speed) {
    case "low":
      return "01";
    case "medium":
      return "02";
    case "high":
      return "03";
    case "turbo":
      return "05";
  }
}

function stateUrl(deviceId: string): string {
  return STATE_URL.replace("{deviceId}", encodeURIComponent(deviceId));
}

function controlUrl(deviceId: string, attribute: string, value: string): string {
  return CTRL_URL
    .replace("{deviceId}", encodeURIComponent(deviceId))
    .replace("{attribute}", attribute)
    .replace("{value}", value);
}

async function expectOk(response: Response): Promise<void> {
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Winix API error ${response.status}: ${body}`);
  }
}

export interface WinixDeviceClient {
  getState(deviceId: string): Promise<WinixDeviceState>;
  setPowerOn(deviceId: string): Promise<void>;
  setModeManual(deviceId: string): Promise<void>;
  setAirflow(deviceId: string, speed: FanSpeed): Promise<void>;
}

export const defaultWinixDeviceClient: WinixDeviceClient = {
  async getState(deviceId: string): Promise<WinixDeviceState> {
    // Read raw attribute map and normalize only fields needed by automation.
    const response = await fetch(stateUrl(deviceId));
    await expectOk(response);
    const payload = (await response.json()) as {
      body?: { data?: Array<{ attributes?: Record<string, string> }> };
      headers?: { resultMessage?: string };
    };
    const resultMessage = payload.headers?.resultMessage?.toLowerCase();
    if (resultMessage === "no data") {
      throw new Error("Winix state endpoint returned no data");
    }

    const attributes = payload.body?.data?.[0]?.attributes;
    if (!attributes) {
      throw new Error("Winix state payload was missing attributes");
    }

    return {
      power: attributes[ATTR_POWER] === POWER_ON ? "on" : "off",
      mode: attributes[ATTR_MODE] === MODE_MANUAL ? "manual" : "auto",
      airflow: airflowToSpeed(attributes[ATTR_AIRFLOW]),
    };
  },
  async setPowerOn(deviceId: string): Promise<void> {
    // Control endpoint is idempotent for repeated same-value writes.
    const response = await fetch(controlUrl(deviceId, ATTR_POWER, POWER_ON));
    await expectOk(response);
  },
  async setModeManual(deviceId: string): Promise<void> {
    const response = await fetch(controlUrl(deviceId, ATTR_MODE, MODE_MANUAL));
    await expectOk(response);
  },
  async setAirflow(deviceId: string, speed: FanSpeed): Promise<void> {
    const response = await fetch(
      controlUrl(deviceId, ATTR_AIRFLOW, speedToAirflow(speed)),
    );
    await expectOk(response);
  },
};
