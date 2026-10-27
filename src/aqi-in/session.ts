import { fetchAqiReading, MUTHANALLUR, type AqiReading, type Fetch } from "./client";
import { AqiAuthError, AqiLoginRejected, AqiLoginShapeError, fetchRealtime, login, renewToken, tokenExpiry } from "./realtime";

export interface SessionStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}
export interface SessionState {
  token?: string;
  expiresAt?: number;
  refreshAt?: number;
  rotationPending?: boolean;
  /** AQI refused to renew (cumulative window closed). The current token is kept until it expires. */
  refreshClosed?: boolean;
  authFailureSince?: number;
  authFailures: number;
  authError?: string;
  lastAuthSuccess?: number;
  lastRefresh?: number;
  lastLogin?: number;
  loginError?: string;
  nextLoginAttempt?: number;
  lastRead?: number;
  lastSource?: "private" | "public";
  lastObservedAt?: string;
  nextPublicPoll?: number;
  lastAlertDay?: string;
  lastAlertAttempt?: number;
  lastAlertSent?: number;
  lastExpiryWarningDay?: string;
  lastError?: string;
}
export interface Credentials { email?: string; password?: string }
export interface ReadResult { reading: AqiReading; source: "private" | "public" }
export type Notify = (subject: string, body: string) => Promise<void>;
const KEY = "aqi-session-v1";
const DAY = 86_400_000;
export const AUTH_ALERT_DELAY = 15 * 60_000;
export const PUBLIC_POLL_INTERVAL = 10 * 60_000;
/** Password sign-in is attempted at most this often, so a wrong password cannot hammer AQI or lock the account. */
export const LOGIN_RETRY_INTERVAL = 30 * 60_000;
/** Email once per IST day once a session that cannot be renewed is this close to expiry. */
export const EXPIRY_WARNING_WINDOW = 3 * DAY;
const istDay = (now: number) => new Date(now + 330 * 60_000).toISOString().slice(0, 10);
const iso = (ms?: number) => ms === undefined ? "none" : new Date(ms).toISOString();

/** Caller must serialize operations; production uses one Durable Object with an in-memory queue. */
export class AqiSessionManager {
  private credentials: Credentials;
  constructor(private storage: SessionStorage, private notify: Notify, private request: Fetch = fetch,
    credentials: Credentials = {}) {
    // Secrets uploaded from files or clipboards often carry a trailing newline; AQI rejects it as a wrong password.
    this.credentials = { email: credentials.email?.trim(), password: credentials.password?.trim() };
  }
  private async state(): Promise<SessionState> { return await this.storage.get<SessionState>(KEY) ?? { authFailures: 0 }; }
  private save(state: SessionState) { return this.storage.put(KEY, state); }
  private nextRefresh(now: number, expires: number) { return now + Math.min(DAY, Math.max(60_000, (expires - now) / 2)); }
  private hasCredentials() { return !!this.credentials.email && !!this.credentials.password; }
  private usable(s: SessionState, now: number) { return !!s.token && !s.rotationPending && now < (s.expiresAt ?? 0) - 60_000; }
  private recovered(state: SessionState, now: number) {
    state.authFailures = 0; delete state.authFailureSince; delete state.authError;
    state.lastAuthSuccess = now;
  }
  private failed(state: SessionState, now: number, code: string) {
    state.authFailureSince ??= now; state.authFailures++; state.authError = code;
  }
  private install(s: SessionState, token: string, now: number) {
    s.token = token; s.expiresAt = tokenExpiry(token); s.refreshAt = this.nextRefresh(now, s.expiresAt);
    delete s.rotationPending; delete s.refreshClosed;
  }

  async status() {
    const s = await this.state();
    return { configured: !!s.token, expiresAt: s.expiresAt, refreshAt: s.refreshAt,
      rotationPending: !!s.rotationPending, refreshClosed: !!s.refreshClosed,
      passwordLoginConfigured: this.hasCredentials(), lastLogin: s.lastLogin, loginError: s.loginError,
      nextLoginAttempt: s.nextLoginAttempt, authFailureSince: s.authFailureSince,
      authFailures: s.authFailures, authError: s.authError, lastAuthSuccess: s.lastAuthSuccess,
      lastRefresh: s.lastRefresh, lastRead: s.lastRead, lastSource: s.lastSource,
      lastObservedAt: s.lastObservedAt, lastAlertDay: s.lastAlertDay, lastAlertSent: s.lastAlertSent,
      lastExpiryWarningDay: s.lastExpiryWarningDay, lastError: s.lastError };
  }

  async seed(token: string, now: number) {
    if (tokenExpiry(token) <= now + 60_000) throw new AqiAuthError("seed_token_expired");
    // Prove the supplied credential can access this exact monitor before replacing working state.
    await fetchRealtime(token, now, this.request);
    const s = await this.state();
    this.install(s, token, now);
    delete s.lastError; delete s.nextPublicPoll; delete s.loginError; delete s.nextLoginAttempt;
    this.recovered(s, now); await this.save(s);
    return this.status();
  }

  /** Operator check: sign in with the configured password and read the device, without touching stored state. */
  async verifyLogin(now: number) {
    if (!this.hasCredentials()) return { passwordLoginConfigured: false };
    try {
      const token = await login(this.credentials.email!, this.credentials.password!, now, this.request);
      const reading = await fetchRealtime(token, now, this.request);
      return { passwordLoginConfigured: true, loginOk: true, deviceMatched: true,
        validityMinutes: Math.round((tokenExpiry(token) - now) / 60_000), deviceObservedAt: reading.observedAt };
    } catch (e) {
      return { passwordLoginConfigured: true, loginOk: false,
        error: e instanceof Error ? e.message : "login_failed",
        ...(e instanceof AqiLoginShapeError ? { responseFields: e.fields } : {}),
        ...(e instanceof AqiLoginRejected ? { httpStatus: e.httpStatus, detail: e.detail, invalidFields: e.fields } : {}) };
    }
  }

  private async rotate(s: SessionState, now: number) {
    if (!s.token || s.rotationPending) throw new AqiAuthError(s.rotationPending ? "renewal_outcome_unknown" : "authentication_required");
    // Persist intent first. A crash or lost response must never cause reuse of an invalidated token.
    s.rotationPending = true; await this.save(s);
    try {
      const replacement = await renewToken(s.token, now, this.request);
      this.install(s, replacement, now); s.lastRefresh = now;
      await this.save(s); // Durable before any subsequent reads or response to caller.
    } catch (error) {
      if (error instanceof AqiAuthError && error.code === "auth_rejected") {
        // A definite refusal: AQI answered and did not rotate, so the current token was not consumed.
        // Keep it for its remaining lifetime instead of discarding a working credential.
        delete s.rotationPending; s.refreshClosed = true; await this.save(s);
        throw new AqiAuthError("refresh_rejected");
      }
      delete s.token; delete s.expiresAt; delete s.refreshAt;
      // Keep the intent marker on uncertain outcomes, including a failed persistence operation.
      s.rotationPending = true; await this.save(s);
      throw new AqiAuthError(error instanceof AqiAuthError ? error.code : "renewal_outcome_unknown");
    }
  }

  /** Start a fresh session with the configured password. Throttled; failures are recorded, not thrown. */
  private async passwordLogin(s: SessionState, now: number): Promise<boolean> {
    if (!this.hasCredentials() || (s.nextLoginAttempt !== undefined && now < s.nextLoginAttempt)) return false;
    // Reserve the attempt before sending so a crash or timeout cannot cause rapid retries.
    s.nextLoginAttempt = now + LOGIN_RETRY_INTERVAL; await this.save(s);
    try {
      this.install(s, await login(this.credentials.email!, this.credentials.password!, now, this.request), now);
      s.lastLogin = now; delete s.loginError; delete s.nextLoginAttempt;
      await this.save(s);
      return true;
    } catch (e) {
      s.loginError = e instanceof Error ? e.message : "login_failed";
      await this.save(s);
      return false;
    }
  }

  /** Make sure s.token is usable now: renew when due, sign in again when renewal is refused, else keep what still works. */
  private async ensureSession(s: SessionState, now: number) {
    if (!s.token || s.rotationPending) {
      if (await this.passwordLogin(s, now)) return;
      throw new AqiAuthError(s.rotationPending ? "renewal_outcome_unknown" : "authentication_required");
    }
    if (now < (s.refreshAt ?? 0) && now < (s.expiresAt ?? 0) - 60_000) return;
    let failure: unknown = new AqiAuthError("refresh_rejected");
    if (!s.refreshClosed) {
      try { await this.rotate(s, now); return; } catch (e) { failure = e; }
    }
    if (await this.passwordLogin(s, now)) return;
    if (this.usable(s, now)) return; // Renewal refused but the current token has not expired yet.
    throw failure;
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
    const day = istDay(now);
    if (s.authFailureSince === undefined || now - s.authFailureSince < AUTH_ALERT_DELAY || s.authFailures < 3 ||
        s.lastAlertDay === day || (s.lastAlertSent !== undefined && now - s.lastAlertSent < DAY) ||
        (s.lastAlertAttempt !== undefined && now - s.lastAlertAttempt < 60 * 60_000)) return;
    // Reserve the day before sending: an ambiguous delivery must not spam duplicate messages.
    s.lastAlertDay = day; s.lastAlertAttempt = now; await this.save(s);
    try {
      await this.notify("[Home AQI] bellezea-outdoor authentication needs attention",
        `AQI account access for bellezea-outdoor has been failing since ${iso(s.authFailureSince)}.\n` +
        `Reason: ${s.authError}.\n` +
        (this.hasCredentials() ? `Automatic password sign-in also failed: ${s.loginError ?? "not attempted yet"}.\n`
          : "Automatic password sign-in is not configured.\n") +
        `Public data fallback is enabled, but it can be delayed and does not include device temperature or humidity.\n` +
        `Last successful authenticated read: ${iso(s.lastAuthSuccess)}.\n\n` +
        "Check the AQI.in password stored as the AQI_PASSWORD Worker secret, or sign in at https://dash.aqi.in/devices/8CBFEA3754B4 " +
        "and reseed the backend session using the documented authenticated admin flow.\n" +
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

  /** The session works but can no longer be renewed: warn before it expires and data drops to the public fallback. */
  private async warnExpiry(s: SessionState, now: number) {
    const day = istDay(now);
    if (!s.refreshClosed || !s.token || s.expiresAt === undefined || s.expiresAt - now > EXPIRY_WARNING_WINDOW ||
        s.lastExpiryWarningDay === day) return;
    s.lastExpiryWarningDay = day; await this.save(s);
    try {
      await this.notify("[Home AQI] bellezea-outdoor session expires soon",
        `AQI.in no longer renews the bellezea-outdoor session. The current session keeps working until ${iso(s.expiresAt)}.\n` +
        (this.hasCredentials() ? `Automatic password sign-in is failing: ${s.loginError ?? "not attempted yet"}. It is retried every 30 minutes.\n`
          : "Automatic password sign-in is not configured.\n") +
        "To avoid a gap, check the AQI_PASSWORD Worker secret, or sign in at https://dash.aqi.in/devices/8CBFEA3754B4 and reseed " +
        "the backend session using the documented authenticated admin flow.\n" +
        "This reminder repeats once per day until the session is renewed.\n" +
        "Dashboard: https://aqi.murali.page/bellezea-outdoor\n");
    } catch {
      console.error(JSON.stringify({ event: "aqi_expiry_email_failed" }));
      s.lastError = "email_delivery_failed";
    }
    await this.save(s);
  }

  async read(now: number): Promise<ReadResult | null> {
    const s = await this.state(); s.lastRead = now;
    let result: ReadResult | null = null;
    try {
      await this.ensureSession(s, now);
      let reading: AqiReading;
      try { reading = await fetchRealtime(s.token!, now, this.request); }
      catch (e) {
        if (!(e instanceof AqiAuthError) || e.code !== "auth_rejected") throw e;
        // The token was refused, so it must not be kept as a fallback. Renew it once, or sign in again.
        s.expiresAt = now; s.refreshAt = now;
        await this.ensureSession(s, now);
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
    await this.warnExpiry(s, now);
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
