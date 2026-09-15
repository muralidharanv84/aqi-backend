// Port of airqualitymonitor/device/utils.py::aqi_us_from_pm25 at commit
// 4805e1ca354f5b85c63d21bbbde59ad2c3318e74. Keep the firmware's breakpoints
// and Python's ties-to-even rounding so indoor/outdoor readings agree.
const BREAKPOINTS = [
  [0.0, 12.0, 0, 50],
  [12.1, 35.4, 51, 100],
  [35.5, 55.4, 101, 150],
  [55.5, 150.4, 151, 200],
  [150.5, 250.4, 201, 300],
  [250.5, 350.4, 301, 400],
  [350.5, 500.4, 401, 500],
] as const;

export function aqiUsFromPm25(pm25: number): number {
  if (!Number.isFinite(pm25) || pm25 < 0) {
    throw new Error("PM2.5 must be finite and non-negative");
  }
  const pm = Math.trunc(pm25 * 10) / 10;
  if (pm > 500.4) return 500;
  for (const [cLow, cHigh, iLow, iHigh] of BREAKPOINTS) {
    if (cLow <= pm && pm <= cHigh) {
      const aqi = (iHigh - iLow) / (cHigh - cLow) * (pm - cLow) + iLow;
      const floor = Math.floor(aqi);
      return aqi - floor === 0.5 ? floor + (floor % 2) : Math.round(aqi);
    }
  }
  throw new Error("No PM2.5 breakpoint matched");
}
