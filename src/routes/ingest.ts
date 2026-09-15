import type { Env } from "../env";
import { verifyDeviceRequest } from "../utils/auth";
import { parseMetrics } from "../utils/metrics";
import { writeSample } from "../utils/samples";
import { minuteBucketTimestamp } from "../utils/time";

function badRequest(message: string): Response {
  return Response.json({ ok: false, error: message }, { status: 400 });
}

export async function handleIngest(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") {
    return Response.json({ ok: false }, { status: 405 });
  }

  const auth = await verifyDeviceRequest(req, env);
  if (!auth.ok) return auth.response;
  const { deviceId, body: rawBody } = auth;

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return badRequest("Invalid JSON");
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return badRequest("Invalid JSON");
  }

  const parsed = parseMetrics(payload as Record<string, unknown>);
  if ("error" in parsed) return badRequest(parsed.error);

  const ts = minuteBucketTimestamp(Date.now());

  await writeSample(env.DB, deviceId, ts, parsed.metrics);

  return Response.json({ ok: true, ts });
}
