import { MUTHANALLUR } from "../../src/aqi-in/client";
export const NOW = Date.parse("2026-10-13T03:58:40Z");
export function jwt(exp = NOW + 28 * 86400_000, suffix = "fixture") {
  return `e30.${btoa(JSON.stringify({ exp: exp / 1000, iat: NOW / 1000 })).replace(/=/g, "")}.${suffix}`;
}
export function payload() {
  return { status: 1, data: [{ serialNo: String(MUTHANALLUR.uid), isOnline: 1, device_timezone: "Asia/Kolkata", last_updated: "2026-10-13 09:28:20 AM", realtime: [
    { sensorid: 3, sensorvalue: 62, unit: "µg/m³" }, { sensorid: 4, sensorvalue: 76, unit: "µg/m³" },
    { sensorid: 11, sensorvalue: 25.4, unit: "°C" }, { sensorid: 12, sensorvalue: 64, unit: "%" },
    { sensorid: 13, sensorvalue: 50, unit: "dB" }, { sensorid: 18, sensorvalue: 34.374, unit: "ppm" },
  ] }] };
}
