import type { Env } from "../env";

type DeviceRow = {
  device_id: string;
  timezone: string;
};

function methodNotAllowed(): Response {
  return Response.json({ ok: false }, { status: 405 });
}

export async function handleDevices(req: Request, env: Env): Promise<Response> {
  if (req.method !== "GET") return methodNotAllowed();

  const rows = await env.DB
    .prepare("SELECT device_id, timezone FROM devices ORDER BY device_id ASC")
    .all<DeviceRow>();

  return Response.json({ devices: rows.results ?? [] });
}
