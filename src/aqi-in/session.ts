import { fetchAqiReading, MUTHANALLUR, type AqiReading, type Fetch } from "./client";
import { AqiAuthError, fetchRealtime, renewToken, tokenExpiry } from "./realtime";

export interface SessionStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}
export interface SessionState {
  token?: string;
  expiresAt?: number;
  refreshAt?: number;
  rotationPending?: boolean;
  authFailureSince?: number;
  authFailures: number;
  authError?: string;
  lastAuthSuccess?: number;
  lastRefresh?: number;
  lastRead?: number;
  lastSource?: "private" | "public";
  lastObservedAt?: string;
  nextPublicPoll?: number;
  lastAlertDay?: string;
  lastAlertAttempt?: number;
  lastAlertSent?: number;
  lastError?: string;
}
export interface ReadResult { reading: AqiReading; source: "private" | "public" }
export type Notify = (subject: string, body: string) => Promise<void>;
const KEY = "aqi-session-v1";
const DAY = 86_400_000;
export const AUTH_ALERT_DELAY = 15 * 60_000;
export const PUBLIC_POLL_INTERVAL = 10 * 60_000;

/** Caller must serialize operations; production uses one Durable Object with an in-memory queue. */
export class AqiSessionManager {
  constructor(private storage: SessionStorage, private notify: Notify, private request: Fetch = fetch) {}
  private async state(): Promise<SessionState> { return await this.storage.get<SessionState>(KEY) ?? { authFailures: 0 }; }
  private save(state: SessionState) { return this.storage.put(KEY, state); }
  private nextRefresh(now: number, expires: number) { return now + Math.min(DAY, Math.max(60_000, (expires - now) / 2)); }
  private recovered(state: SessionState, now: number) {
    state.authFailures = 0; delete state.authFailureSince; delete state.authError;
    state.lastAuthSuccess = now;
  }
  private failed(state: SessionState, now: number, code: string) {
    state.authFailureSince ??= now; state.authFailures++; state.authError = code;
  }

  async status() {
    const s = await this.state();
    return { configured: !!s.token, expiresAt: s.expiresAt, refreshAt: s.refreshAt,
      rotationPending: !!s.rotationPending, authFailureSince: s.authFailureSince,
      authFailures: s.authFailures, authError: s.authError, lastAuthSuccess: s.lastAuthSuccess,
      lastRefresh: s.lastRefresh, lastRead: s.lastRead, lastSource: s.lastSource,
      lastObservedAt: s.lastObservedAt, lastAlertDay: s.lastAlertDay, lastAlertSent: s.lastAlertSent,
      lastError: s.lastError };
  }

  async seed(token: string, now: number) {
    if (tokenExpiry(token) <= now + 60_000) throw new AqiAuthError("seed_token_expired");
    // Prove the supplied credential can access this exact monitor before replacing working state.
    await fetchRealtime(token, now, this.request);
    const s = await this.state();
    s.token = token; s.expiresAt = tokenExpiry(token); s.refreshAt = this.nextRefresh(now, s.expiresAt);
    delete s.rotationPending; delete s.lastError; delete s.nextPublicPoll;
    this.recovered(s, now); await this.save(s);
    return this.status();
  }

  private async rotate(s: SessionState, now: number) {
    if (!s.token || s.rotationPending) throw new AqiAuthError(s.rotationPending ? "renewal_outcome_unknown" : "authentication_required");
    // Persist intent first. A crash or lost response must never cause reuse of an invalidated token.
    s.rotationPending = true; await this.save(s);
    try {
      const replacement = await renewToken(s.token, now, this.request);
      s.token = replacement; s.expiresAt = tokenExpiry(replacement);
      s.refreshAt = this.nextRefresh(now, s.expiresAt); s.lastRefresh = now;
      delete s.rotationPending;
      await this.save(s); // Durable before any subsequent reads or response to caller.
    } catch (error) {
      delete s.token; delete s.expiresAt; delete s.refreshAt;
      // Keep the intent marker on uncertain outcomes, including a failed persistence operation.
      s.rotationPending = true; await this.save(s);
      throw new AqiAuthError(error instanceof AqiAuthError ? error.code : "renewal_outcome_unknown");
    }
  }

  async refresh(now: number) {
    const s = await this.state();
    try { await this.rotate(s, now); }
    catch (error) {
      this.failed(s, now, error instanceof AqiAuthError ? error.code : "renewal_outcome_unknown");
      await this.save(s); throw error;
    }
    // A successful refresh is not sufficient to declare device access restored.
    await this.read(now);
    return this.status();
  }

  private async alert(s: SessionState, now: number) {
    const day = new Date(now + 330 * 60_000).toISOString().slice(0, 10);
    if (s.authFailureSince === undefined || now - s.authFailureSince < AUTH_ALERT_DELAY || s.authFailures < 3 ||
        s.lastAlertDay === day || (s.lastAlertSent !== undefined && now - s.lastAlertSent < DAY) ||
        (s.lastAlertAttempt !== undefined && now - s.lastAlertAttempt < 60 * 60_000)) return;
    // Reserve the day before sending: an ambiguous delivery must not spam duplicate messages.
    s.lastAlertDay = day; s.lastAlertAttempt = now; await this.save(s);
    try {
      await this.notify("[Home AQI] bellezea-outdoor authentication needs attention",
        `AQI account access for bellezea-outdoor has been failing since ${new Date(s.authFailureSince).toISOString()}.\n` +
        `Reason: ${s.authError}.\nPublic data fallback is enabled, but it can be delayed and does not include device temperature or humidity.\n` +
        `Last successful authenticated read: ${s.lastAuthSuccess ? new Date(s.lastAuthSuccess).toISOString() : "none"}.\n\n` +
        "Sign in at https://dash.aqi.in/devices/8CBFEA3754B4 and reseed the backend session using the documented authenticated admin flow.\n" +
        "One reminder per day will continue while authentication is failing. Reminders stop automatically after device access is restored.\n" +
        "Dashboard: https://aqi.murali.page/bellezea-outdoor\n");
      s.lastAlertSent = now;
    } catch {
      // Delivery may be ambiguous. Retain the reservation; report failure without upstream details.
      console.error(JSON.stringify({ event: "aqi_auth_email_failed" }));
      s.lastError = "email_delivery_failed";
    }
    await this.save(s);
  }

  async read(now: number): Promise<ReadResult | null> {
    const s = await this.state(); s.lastRead = now;
    let result: ReadResult | null = null;
    try {
      if (s.rotationPending || !s.token) throw new AqiAuthError(s.rotationPending ? "renewal_outcome_unknown" : "authentication_required");
      if (now >= (s.refreshAt ?? 0) || now >= (s.expiresAt ?? 0) - 60_000) await this.rotate(s, now);
      let reading: AqiReading;
      try { reading = await fetchRealtime(s.token!, now, this.request); }
      catch (e) {
        if (!(e instanceof AqiAuthError) || e.code !== "auth_rejected") throw e;
        // Expired access tokens can sometimes still be refreshed. Try once, then require reauthentication.
        await this.rotate(s, now);
        reading = await fetchRealtime(s.token!, now, this.request);
      }
      this.recovered(s, now); delete s.lastError;
      if (reading.online && now - Date.parse(reading.observedAt) <= 5 * 60_000) result = { reading, source: "private" };
      else s.lastError = "private_reading_stale_or_offline";
    } catch (e) {
      if (e instanceof AqiAuthError) {
        this.failed(s, now, e.code); delete s.token; delete s.expiresAt; delete s.refreshAt;
        s.lastError = e.code;
      } else s.lastError = "private_upstream_unavailable";
    }
    await this.save(s);
    // Alert failures cannot prevent the fallback. Data failures cannot prevent alerts either.
    await this.alert(s, now);
    if (!result && now >= (s.nextPublicPoll ?? 0)) {
      s.nextPublicPoll = now + PUBLIC_POLL_INTERVAL; await this.save(s);
      try { result = { source: "public", reading: await fetchAqiReading(MUTHANALLUR, { fetch: this.request, nowMs: now }) }; }
      catch { s.lastError = "public_fallback_unavailable"; }
    }
    if (result) { s.lastSource = result.source; s.lastObservedAt = result.reading.observedAt; }
    await this.save(s);
    return result;
  }
}
