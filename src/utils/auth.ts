import type { Env } from "../env";
import { hmacSha256Hex, timingSafeEqual } from "./crypto";

type AuthSuccess = { ok: true; deviceId: string; body: string };
type AuthFailure = { ok: false; response: Response };

function unauthorized(): Response {
  return Response.json({ ok: false }, { status: 401 });
}

export async function verifyDeviceRequest(
  req: Request,
  env: Env,
): Promise<AuthSuccess | AuthFailure> {
  const deviceId = req.headers.get("X-Device-Id");
  const signature = req.headers.get("X-Signature");

  if (!deviceId || !signature) return { ok: false, response: unauthorized() };

  const body = await req.text();

  const secretRow = await env.DB
    .prepare("SELECT secret_hash FROM devices WHERE device_id = ?")
    .bind(deviceId)
    .first<{ secret_hash: string }>();

  if (!secretRow?.secret_hash) return { ok: false, response: unauthorized() };

  const expectedSig = await hmacSha256Hex(secretRow.secret_hash, body);
  if (!timingSafeEqual(signature.toLowerCase(), expectedSig)) {
    return { ok: false, response: unauthorized() };
  }

  return { ok: true, deviceId, body };
}
