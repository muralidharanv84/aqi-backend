const ALLOWED_ORIGINS = new Set([
  "https://aqi.orangeiqlabs.com",
  "http://localhost:3000",
  "http://localhost:5173",
]);

function corsHeaders(origin: string | null): Headers {
  const h = new Headers();

  if (!origin || !ALLOWED_ORIGINS.has(origin)) return h;

  h.set("Access-Control-Allow-Origin", origin);
  h.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type");
  h.set("Access-Control-Max-Age", "86400");
  h.set("Vary", "Origin");

  return h;
}

function withCors(req: Request, res: Response): Response {
  const origin = req.headers.get("Origin");
  const cors = corsHeaders(origin);

  const headers = new Headers(res.headers);
  cors.forEach((v, k) => headers.set(k, v));

  return new Response(res.body, { status: res.status, headers });
}

export interface Env {
  DB: D1Database;
}

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
    const headers = new Headers({ "Cache-Control": "no-store" });
    return withCors(req, Response.json({ ok: true }, { headers }));
  }

  // Example route (your current DB ping)
  const row = await env.DB.prepare("SELECT 1 AS ok, datetime('now') AS now").first();
  return withCors(req, Response.json(row));
}
