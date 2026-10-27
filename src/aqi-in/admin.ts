import type { Env } from "../env";
import { readBounded } from "./client";
import { runAqiInPoll } from "../cron/aqiIn";

export async function handleAqiAdmin(req: Request, env: Env): Promise<Response> {
  const headers = new Headers({ "Cache-Control": "no-store" });
  if (req.headers.get("Origin") === "https://dash.aqi.in") {
    headers.set("Access-Control-Allow-Origin", "https://dash.aqi.in");
    headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    headers.set("Vary", "Origin");
  }
  const respond = (body: unknown, status = 200) => Response.json(body, { status, headers });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (!env.AQI_ADMIN_KEY || !env.AQI_SESSION) return respond({ error: "unavailable" }, 503);
  const supplied = req.headers.get("Authorization") ?? "";
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([supplied, `Bearer ${env.AQI_ADMIN_KEY}`].map(s => crypto.subtle.digest("SHA-256", encoder.encode(s))));
  const aa = new Uint8Array(a), bb = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < aa.length; i++) difference |= aa[i] ^ bb[i];
  if (difference) return respond({ error: "unauthorized" }, 401);
  const action = new URL(req.url).pathname.slice("/internal/aqi/".length);
  if ((action === "status" && req.method !== "GET") || (action !== "status" && req.method !== "POST")) return respond({ error: "method_not_allowed" }, 405);
  if (!["status", "session", "refresh", "poll", "test-email", "verify-fallback", "verify-login"].includes(action)) return respond({ error: "not_found" }, 404);
  if (action === "poll") {
    try { await runAqiInPoll(env); return respond({ ok: true }); }
    catch { return respond({ error: "poll_failed" }, 502); }
  }
  let body: string | undefined;
  if (action === "session") {
    try {
      body = await readBounded(new Response(req.body));
      if (body.length > 16_384) return respond({ error: "body_too_large" }, 413);
      const parsed = JSON.parse(body);
      if (typeof parsed?.token !== "string" || parsed.token.length > 8192) return respond({ error: "invalid_token_input" }, 400);
    } catch { return respond({ error: "invalid_body" }, 400); }
  }
  const id = env.AQI_SESSION.idFromName(action === "verify-fallback" ? "bellezea-outdoor-verification" : "bellezea-outdoor");
  const response = await env.AQI_SESSION.get(id).fetch(`https://session/${action}`, { method: req.method, body });
  headers.set("Content-Type", "application/json");
  return new Response(response.body, { status: response.status, headers });
}
