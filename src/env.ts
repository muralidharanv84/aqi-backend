export interface EnvBindings {
  DB: D1Database;
  AQI_SESSION?: DurableObjectNamespace;
  AQI_ADMIN_KEY?: string;
  AQI_ALERT_EMAIL?: SendEmail;
  AQI_ALERT_FROM?: string;
  AQI_ALERT_TO?: string;
  WINIX_USERNAME?: string;
  WINIX_PASSWORD?: string;
  WINIX_MONITOR_DEVICE_ID?: string;
  WINIX_TARGET_DEVICE_IDS?: string;
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
