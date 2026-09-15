import { describe, expect, it } from "vitest";
import { aqiUsFromPm25 } from "../src/utils/aqi";

describe("AQI parity with custom-monitor firmware", () => {
  it.each([
    [0, 0], [3, 12], [9, 38], [12, 50], [12.09, 50], [12.1, 51],
    [35.4, 100], [35.5, 101], [55.4, 150], [55.5, 151],
    [150.4, 200], [150.5, 201], [250.4, 300], [250.5, 301],
    [350.4, 400], [350.5, 401], [500.4, 500], [999, 500],
  ])("converts PM2.5 %s to AQI %s", (pm25, expected) => {
    expect(aqiUsFromPm25(pm25)).toBe(expected);
  });
  it.each([-1, NaN, Infinity])("rejects invalid PM2.5 %s", pm25 => {
    expect(() => aqiUsFromPm25(pm25)).toThrow("finite and non-negative");
  });
});
