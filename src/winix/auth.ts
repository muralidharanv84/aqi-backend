import {
  COGNITO_APP_CLIENT_ID,
  COGNITO_CLIENT_SECRET_KEY,
  COGNITO_REGION,
  COGNITO_USER_POOL_ID,
  WINIX_REFRESH_MARGIN_SECONDS,
} from "./constants";
import type { StoredWinixAuthState } from "./types";

/**
 * Worker-safe Winix authentication.
 *
 * Why this exists:
 * - Winix uses AWS Cognito with SRP (USER_SRP_AUTH).
 * - The off-the-shelf `winix-api` package uses Node-specific runtime behavior that
 *   is not available in Cloudflare Workers.
 * - This file implements the minimal SRP + refresh flow using Web Crypto APIs only.
 *
 * Important behavior:
 * - `login()` performs SRP challenge-response against Cognito.
 * - `refresh()` performs REFRESH_TOKEN auth flow.
 * - `resolveWinixAuthState()` prefers stored fresh token, then refresh, then full login.
 */
export interface WinixAuthProvider {
  login(username: string, password: string): Promise<StoredWinixAuthState>;
  refresh(refreshToken: string, userId: string): Promise<StoredWinixAuthState>;
}

const AUTH_ENDPOINT = `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/`;
const PASSWORD_VERIFIER_CHALLENGE = "PASSWORD_VERIFIER";

// SRP group constants (N, g) used by Cognito USER_SRP_AUTH.
const N_HEX =
  "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD1" +
  "29024E088A67CC74020BBEA63B139B22514A08798E3404DD" +
  "EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245" +
  "E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED" +
  "EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3D" +
  "C2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F" +
  "83655D23DCA3AD961C62F356208552BB9ED529077096966D" +
  "670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B" +
  "E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9" +
  "DE2BCBF6955817183995497CEA956AE515D2261898FA0510" +
  "15728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64" +
  "ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7" +
  "ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6B" +
  "F12FFA06D98A0864D87602733EC86A64521F2B18177B200C" +
  "BBE117577A615D6C770988C0BAD946E208E24FA074E5AB31" +
  "43DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF";

const G_HEX = "2";
const INFO_BITS = new TextEncoder().encode("Caldera Derived Key");
const BIG_N = BigInt(`0x${N_HEX}`);
const BIG_G = BigInt(`0x${G_HEX}`);
// Precomputed k = H(N | g), from Cognito SRP reference algorithm.
const BIG_K = BigInt(
  "0x538282c4354742d7cbbde2359fcf67f9f5b3a6b08791e5011b43b8a5b66d9ee6",
);

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(digest)).padStart(64, "0");
}

async function hexHash(hexString: string): Promise<string> {
  return sha256Hex(hexToBytes(hexString));
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.length % 2 === 1 ? `0${hex}` : hex;
  const out = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < normalized.length; i += 2) {
    out[i / 2] = Number.parseInt(normalized.slice(i, i + 2), 16);
  }
  return out;
}

function base64ToBytes(base64: string): Uint8Array {
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    out[i] = raw.charCodeAt(i);
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw);
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function padHex(value: bigint | string): string {
  let hex = typeof value === "bigint" ? value.toString(16) : value;
  if (hex.length % 2 === 1) hex = `0${hex}`;
  const first = hex[0]?.toLowerCase();
  if (["8", "9", "a", "b", "c", "d", "e", "f"].includes(first)) {
    hex = `00${hex}`;
  }
  return hex;
}

function powMod(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let current = base % modulus;
  let exp = exponent;
  while (exp > 0n) {
    if (exp % 2n === 1n) result = (result * current) % modulus;
    exp /= 2n;
    current = (current * current) % modulus;
  }
  return result;
}

function randomBigInt(byteLength: number): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return BigInt(`0x${bytesToHex(bytes)}`);
}

function formattedTimestamp(now: Date): string {
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ] as const;
  const pad2 = (value: number): string => String(value).padStart(2, "0");
  return `${weekdays[now.getUTCDay()]} ${months[now.getUTCMonth()]} ${now.getUTCDate()} ${pad2(now.getUTCHours())}:${pad2(now.getUTCMinutes())}:${pad2(now.getUTCSeconds())} UTC ${now.getUTCFullYear()}`;
}

function decodeJwtSub(token: string): string {
  const parts = token.split(".");
  if (parts.length < 2) throw new Error("Invalid JWT token");

  const payloadB64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = payloadB64.padEnd(
    payloadB64.length + ((4 - (payloadB64.length % 4)) % 4),
    "=",
  );
  const payload = JSON.parse(
    new TextDecoder().decode(base64ToBytes(padded)),
  ) as { sub?: string };
  if (!payload.sub) throw new Error("JWT token missing sub claim");
  return payload.sub;
}

async function hmacSha256(
  keyBytes: Uint8Array,
  messageBytes: Uint8Array,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, messageBytes);
  return new Uint8Array(signature);
}

async function computeSecretHash(username: string): Promise<string> {
  // Cognito client secret hash = Base64(HMAC_SHA256(clientSecret, username + clientId))
  const message = utf8(`${username}${COGNITO_APP_CLIENT_ID}`);
  const key = utf8(COGNITO_CLIENT_SECRET_KEY);
  return bytesToBase64(await hmacSha256(key, message));
}

async function computePasswordAuthenticationKey(
  smallA: bigint,
  largeA: bigint,
  userIdForSrp: string,
  password: string,
  serverBHex: string,
  saltHex: string,
): Promise<Uint8Array> {
  // Derive HKDF key used in PASSWORD_CLAIM_SIGNATURE computation.
  const serverB = BigInt(`0x${serverBHex}`);
  const salt = BigInt(`0x${saltHex}`);
  const uValue = BigInt(
    `0x${await hexHash(`${padHex(largeA)}${padHex(serverB)}`)}`,
  );
  if (uValue === 0n) {
    throw new Error("Winix auth failed: computed U value is zero");
  }

  const poolShort = COGNITO_USER_POOL_ID.split("_")[1];
  const usernamePassword = `${poolShort}${userIdForSrp}:${password}`;
  const usernamePasswordHash = await sha256Hex(utf8(usernamePassword));
  const xValue = BigInt(
    `0x${await hexHash(`${padHex(salt)}${usernamePasswordHash}`)}`,
  );

  const gModPowX = powMod(BIG_G, xValue, BIG_N);
  const intValue2 = serverB - BIG_K * gModPowX;
  const sValue = powMod(intValue2, smallA + uValue * xValue, BIG_N);

  const ikm = hexToBytes(padHex(sValue));
  const saltBytes = hexToBytes(padHex(uValue.toString(16)));
  const prk = await hmacSha256(saltBytes, ikm);
  const info = concatBytes(INFO_BITS, new Uint8Array([1]));
  const hmac = await hmacSha256(prk, info);
  return hmac.slice(0, 16);
}

async function cognitoRequest(
  target: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // Cognito JSON RPC endpoint shared across auth calls; target determines operation.
  const response = await fetch(AUTH_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": target,
    },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as Record<string, unknown>;

  if (!response.ok) {
    const message = String(payload.message ?? payload.__type ?? response.statusText);
    throw new Error(`Cognito request failed: ${message}`);
  }

  if (typeof payload.__type === "string") {
    throw new Error(`Cognito request failed: ${payload.__type}`);
  }
  return payload;
}

type CognitoAuthResult = {
  AccessToken: string;
  RefreshToken?: string;
  ExpiresIn: number;
};

async function loginWithSrp(
  username: string,
  password: string,
): Promise<StoredWinixAuthState> {
  // 1) Initiate USER_SRP_AUTH with computed SRP_A.
  const smallA = randomBigInt(128) % BIG_N;
  const largeA = powMod(BIG_G, smallA, BIG_N);
  if (largeA % BIG_N === 0n) {
    throw new Error("Winix auth failed: SRP safety check for A failed");
  }

  const initiate = await cognitoRequest(
    "AWSCognitoIdentityProviderService.InitiateAuth",
    {
      AuthFlow: "USER_SRP_AUTH",
      ClientId: COGNITO_APP_CLIENT_ID,
      AuthParameters: {
        USERNAME: username,
        SRP_A: largeA.toString(16),
        SECRET_HASH: await computeSecretHash(username),
      },
    },
  );

  if (initiate.ChallengeName !== PASSWORD_VERIFIER_CHALLENGE) {
    throw new Error(`Unexpected Cognito challenge: ${String(initiate.ChallengeName)}`);
  }

  const challengeParams = initiate.ChallengeParameters as Record<string, string>;
  const userIdForSrp = challengeParams.USER_ID_FOR_SRP;
  const saltHex = challengeParams.SALT;
  const srpBHex = challengeParams.SRP_B;
  const secretBlock = challengeParams.SECRET_BLOCK;
  if (!userIdForSrp || !saltHex || !srpBHex || !secretBlock) {
    throw new Error("Cognito challenge is missing SRP parameters");
  }

  // 2) Answer PASSWORD_VERIFIER challenge by signing Cognito's secret block.
  const timestamp = formattedTimestamp(new Date());
  const hkdf = await computePasswordAuthenticationKey(
    smallA,
    largeA,
    userIdForSrp,
    password,
    srpBHex,
    saltHex,
  );

  const poolShort = COGNITO_USER_POOL_ID.split("_")[1];
  const messageBytes = concatBytes(
    utf8(poolShort),
    utf8(userIdForSrp),
    base64ToBytes(secretBlock),
    utf8(timestamp),
  );
  const signature = bytesToBase64(await hmacSha256(hkdf, messageBytes));

  const challenge = await cognitoRequest(
    "AWSCognitoIdentityProviderService.RespondToAuthChallenge",
    {
      ChallengeName: PASSWORD_VERIFIER_CHALLENGE,
      ClientId: COGNITO_APP_CLIENT_ID,
      ChallengeResponses: {
        TIMESTAMP: timestamp,
        // This must be the original login username (email), not USER_ID_FOR_SRP.
        USERNAME: username,
        PASSWORD_CLAIM_SECRET_BLOCK: secretBlock,
        PASSWORD_CLAIM_SIGNATURE: signature,
        SECRET_HASH: await computeSecretHash(username),
      },
    },
  );

  const result = challenge.AuthenticationResult as CognitoAuthResult | undefined;
  if (!result?.AccessToken || !result?.RefreshToken || !result?.ExpiresIn) {
    throw new Error("Cognito login did not return complete auth tokens");
  }

  return {
    userId: decodeJwtSub(result.AccessToken),
    accessToken: result.AccessToken,
    refreshToken: result.RefreshToken,
    accessExpiresAt: Math.floor(Date.now() / 1000) + result.ExpiresIn,
  };
}

async function refreshAccessToken(
  refreshToken: string,
  userId: string,
): Promise<StoredWinixAuthState> {
  // Refresh uses Cognito subject (`userId`) for SECRET_HASH generation.
  const response = await cognitoRequest(
    "AWSCognitoIdentityProviderService.InitiateAuth",
    {
      ClientId: COGNITO_APP_CLIENT_ID,
      AuthFlow: "REFRESH_TOKEN",
      AuthParameters: {
        REFRESH_TOKEN: refreshToken,
        SECRET_HASH: await computeSecretHash(userId),
      },
    },
  );

  const result = response.AuthenticationResult as CognitoAuthResult | undefined;
  if (!result?.AccessToken || !result?.ExpiresIn) {
    throw new Error("Cognito refresh did not return an access token");
  }

  return {
    userId,
    accessToken: result.AccessToken,
    refreshToken,
    accessExpiresAt: Math.floor(Date.now() / 1000) + result.ExpiresIn,
  };
}

export const defaultWinixAuthProvider: WinixAuthProvider = {
  login: loginWithSrp,
  refresh: refreshAccessToken,
};

function isAccessTokenFresh(stored: StoredWinixAuthState, nowSec: number): boolean {
  return stored.accessExpiresAt > nowSec + WINIX_REFRESH_MARGIN_SECONDS;
}

export async function resolveWinixAuthState(
  username: string,
  password: string,
  stored: StoredWinixAuthState | null,
  nowSec: number,
  provider: WinixAuthProvider = defaultWinixAuthProvider,
): Promise<StoredWinixAuthState> {
  // Token strategy:
  // 1) use stored access token if still fresh;
  // 2) otherwise refresh;
  // 3) if refresh fails (common with Winix multi-login invalidation), re-login.
  if (!stored) {
    return provider.login(username, password);
  }

  if (isAccessTokenFresh(stored, nowSec)) {
    return stored;
  }

  try {
    return await provider.refresh(stored.refreshToken, stored.userId);
  } catch {
    // Winix commonly invalidates tokens on multi-login; fallback to full login.
    return provider.login(username, password);
  }
}
