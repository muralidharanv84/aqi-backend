const ALLOWED_ORIGINS = new Set([
  "https://aqi.orangeiqlabs.com",
  "http://localhost:3000",
  "http://localhost:5173",
]);

const ALLOWED_HEADERS = "Content-Type, X-Device-Id, X-Signature";

export function corsHeaders(origin: string | null): Headers {
  const h = new Headers();

  if (!origin || !ALLOWED_ORIGINS.has(origin)) return h;

  h.set("Access-Control-Allow-Origin", origin);
  h.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  h.set("Access-Control-Allow-Headers", ALLOWED_HEADERS);
  h.set("Access-Control-Max-Age", "86400");
  h.set("Vary", "Origin");

  return h;
}

export function withCors(req: Request, res: Response): Response {
  const origin = req.headers.get("Origin");
  const cors = corsHeaders(origin);

  const headers = new Headers(res.headers);
  cors.forEach((v, k) => headers.set(k, v));

  return new Response(res.body, { status: res.status, headers });
}
