export interface EnvBindings {
  DB: D1Database;
  WINIX_USERNAME?: string;
  WINIX_PASSWORD?: string;
  WINIX_MONITOR_DEVICE_ID?: string;
  WINIX_CONTROL_ENABLED?: string;
  WINIX_DEADBAND_UGM3?: string;
  WINIX_MIN_DWELL_MINUTES?: string;
  WINIX_MIN_SAMPLES_5M?: string;
  WINIX_MAX_SAMPLE_AGE_SECONDS?: string;
  WINIX_DRY_RUN?: string;
}

export type Env = EnvBindings;

declare global {
  interface Env extends EnvBindings {}
}

export {};
