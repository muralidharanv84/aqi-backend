import { EmailMessage } from "cloudflare:email";
import type { Env } from "../env";
import { AqiSessionManager } from "./session";
import { AqiAuthError } from "./realtime";

export async function sendAqiEmail(env: Env, subject: string, text: string): Promise<void> {
  if (!env.AQI_ALERT_EMAIL || !env.AQI_ALERT_FROM || !env.AQI_ALERT_TO) throw new Error("AQI alert email is not configured");
  const from = env.AQI_ALERT_FROM, to = env.AQI_ALERT_TO;
  if (/[\r\n]/.test(from + to + subject)) throw new Error("Invalid email header");
  const raw = `From: Home AQI <${from}>\r\nTo: ${to}\r\nSubject: ${subject}\r\n` +
    `Date: ${new Date().toUTCString()}\r\nMessage-ID: <${crypto.randomUUID()}@${from.split("@")[1]}>\r\n` +
    "MIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n" + text;
  await env.AQI_ALERT_EMAIL.send(new EmailMessage(from, to, raw));
}

export class AqiSession {
  private tail: Promise<unknown> = Promise.resolve();
  private manager: AqiSessionManager;
  constructor(private ctx: DurableObjectState, private env: Env) {
    this.manager = new AqiSessionManager(ctx.storage, (subject, body) => sendAqiEmail(env, subject, body), fetch,
      { email: env.AQI_LOGIN_EMAIL, password: env.AQI_PASSWORD });
  }
  async fetch(request: Request): Promise<Response> {
    // Network awaits can interleave Durable Object events; explicitly serialize the entire operation.
    const operation = this.tail.then(() => this.handle(request));
    this.tail = operation.catch(() => {});
    return operation;
  }
  private async handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    try {
      if (path === "/read") return Response.json(await this.manager.read(Date.now()));
      if (path === "/status") return Response.json(await this.manager.status());
      if (path === "/refresh") return Response.json(await this.manager.refresh(Date.now()));
      if (path === "/verify-login") return Response.json(await this.manager.verifyLogin(Date.now()));
      if (path === "/session") {
        const body = await request.json<{ token?: unknown }>();
        if (typeof body.token !== "string" || body.token.length > 8192) return Response.json({ error: "invalid_token_input" }, { status: 400 });
        return Response.json(await this.manager.seed(body.token, Date.now()));
      }
      if (path === "/test-email") {
        await sendAqiEmail(this.env, "[Home AQI] Alert delivery test - bellezea-outdoor",
          "This is the deployment verification email for bellezea-outdoor.\n\n" +
          "Authentication failure reminders are enabled: the first after 15 minutes of persistent failure, then at most one per day until access is restored.\n" +
          "This test does not indicate an authentication failure.\nhttps://aqi.murali.page/bellezea-outdoor\n");
        return Response.json({ sent: true });
      }
      if (path === "/verify-fallback") {
        // Only called on a separate, empty verification object; never mutate the production session.
        const result = await this.manager.read(Date.now());
        const status = await this.manager.status();
        await this.ctx.storage.deleteAll();
        return Response.json({ result, status });
      }
      return new Response(null, { status: 404 });
    } catch (e) {
      // Never emit raw AQI responses, credentials, or arbitrary exception messages.
      return Response.json({ error: e instanceof AqiAuthError ? e.code : "aqi_operation_failed" }, { status: 502 });
    }
  }
}
