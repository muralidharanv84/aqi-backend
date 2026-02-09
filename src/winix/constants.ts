export const WINIX_REFRESH_MARGIN_SECONDS = 10 * 60;

// Pulled from Winix Android app + existing open-source integrations.
export const COGNITO_APP_CLIENT_ID = "14og512b9u20b8vrdm55d8empi";
export const COGNITO_CLIENT_SECRET_KEY =
  "k554d4pvgf2n0chbhgtmbe4q0ul4a9flp3pcl6a47ch6rripvvr";
export const COGNITO_USER_POOL_ID = "us-east-1_Ofd50EosD";
export const COGNITO_REGION = "us-east-1";

export const WINIX_CONTROL_DEFAULTS = {
  enabled: true,
  dryRun: false,
  deadbandUgm3: 2,
  minDwellMinutes: 10,
  minSamples5m: 3,
  maxSampleAgeSeconds: 360,
} as const;
