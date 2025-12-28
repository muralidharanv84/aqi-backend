export function handleHealth(): Response {
  const headers = new Headers({ "Cache-Control": "no-store" });
  return Response.json({ ok: true }, { headers });
}
