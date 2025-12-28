import type { Env } from "../env";

export async function handlePing(env: Env): Promise<Response> {
  const row = await env.DB.prepare("SELECT 1 AS ok, datetime('now') AS now").first();
  return Response.json(row);
}
