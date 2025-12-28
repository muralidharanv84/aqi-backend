import type { Env } from "./env";
import { handleHealth } from "./routes/health";
import { handleIngest } from "./routes/ingest";
import { handleLatest } from "./routes/latest";
import { handlePing } from "./routes/ping";
import { handleSeries } from "./routes/series";
import { corsHeaders, withCors } from "./utils/cors";

export default {
  fetch: (req: Request, env: Env) => handleRequest(req, env),
};

export async function handleRequest(req: Request, env: Env): Promise<Response> {
  // Preflight
  if (req.method === "OPTIONS") {
    const origin = req.headers.get("Origin");
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  const url = new URL(req.url);

  if (req.method === "GET" && url.pathname === "/api/v1/health") {
    return withCors(req, handleHealth());
  }

  if (url.pathname === "/api/v1/ingest") {
    return withCors(req, await handleIngest(req, env));
  }

  const latestMatch = url.pathname.match(
    /^\/api\/v1\/devices\/([^/]+)\/latest$/,
  );
  if (latestMatch) {
    const deviceId = decodeURIComponent(latestMatch[1]);
    return withCors(req, await handleLatest(req, env, deviceId));
  }

  const seriesMatch = url.pathname.match(
    /^\/api\/v1\/devices\/([^/]+)\/series$/,
  );
  if (seriesMatch) {
    const deviceId = decodeURIComponent(seriesMatch[1]);
    return withCors(req, await handleSeries(req, env, deviceId, url));
  }

  if (req.method === "GET" && url.pathname === "/") {
    return withCors(req, await handlePing(env));
  }

  return withCors(req, Response.json({ ok: false }, { status: 404 }));
}
