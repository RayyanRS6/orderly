let token: string | undefined;

function apiBaseUrl(): string {
  const configured = import.meta.env.VITE_API_BASE_URL?.trim();
  if (!configured) return '';

  const invalid = () =>
    new Error(
      'VITE_API_BASE_URL must be an absolute HTTPS backend URL (HTTP is allowed only for localhost), without credentials, a query, or a fragment.',
    );
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw invalid();
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    !/^https?:\/\//i.test(configured) ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw invalid();

  return url.href.replace(/\/+$/, '');
}

let onSessionRejected: (() => void) | undefined;
let tokenSource: (() => Promise<string | undefined>) | undefined;
let recoverSession: (() => Promise<string | undefined>) | undefined;
// One recovery at a time: requests rejected together share it, so they cause one refresh. A
// recovery that could not tell (offline) is shared for a few seconds more, so a burst of polls
// does not ask the sign-in service again and again.
let recovering: Promise<string | undefined> | undefined;
const RECOVERY_COOLDOWN_MS = 10000;

/** Shown when a sign-in could not be checked (offline, or the sign-in service is busy). */
export const SIGN_IN_UNCHECKED =
  'Orderly couldn’t check your sign-in just now. You are still signed in.';
// The backend's answer while Supabase Auth is unreachable or busy (HTTP 503, Retry-After 5).
const SIGN_IN_BUSY = 'Sign-in service is busy, please retry.';

export function setAccessToken(value?: string) {
  token = value;
}
/**
 * Where each request gets its sign-in. The app reads the auth client's current session, which
 * refreshes a token close to expiry even in a background tab. Without a source (demo, tests) the
 * token from setAccessToken is sent.
 */
export function setAccessTokenSource(source?: () => Promise<string | undefined>) {
  tokenSource = source;
}
/**
 * Called when the backend rejects the sign-in this browser sent (HTTP 401): the session
 * was revoked or ended elsewhere, though it is still saved here.
 */
export function setSessionRejectedHandler(handler?: () => void) {
  onSessionRejected = handler;
}
/**
 * Tried before anyone is signed out, once for a 401 on the sign-in this browser sent. Resolves
 * with a fresh token, and the request is sent once more with it, or with undefined when the
 * sign-in is definitely gone (the rejected handler then runs). Throws when it could not tell,
 * such as offline: the request fails and nobody is signed out.
 */
export function setSessionRecovery(recover?: () => Promise<string | undefined>) {
  recoverSession = recover;
  recovering = undefined;
}
/**
 * A signal that aborts after `ms`. AbortSignal.timeout is missing on iOS 15 and older Android
 * WebViews, where calling it would fail every request.
 */
export function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}
/** A failed request: the server's message, plus its status, code and body for callers that need them. */
export class ApiError extends Error {
  status: number;
  code?: string;
  data: unknown;
  /** Seconds to wait before asking again, when the server said so and the browser can read it. */
  retryAfter?: number;
  constructor(message: string, status: number, data: unknown, retryAfter?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
    const code = (data as { code?: unknown } | null)?.code;
    if (typeof code === 'string') this.code = code;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}
async function currentToken() {
  if (!tokenSource) return token;
  try {
    // A refresh that failed for now leaves no session to read: send the last token, so the
    // server gives the answer.
    return (await tokenSource()) ?? token;
  } catch {
    return token;
  }
}
function recoverOnce() {
  if (!recovering) {
    const attempt = recoverSession!();
    recovering = attempt;
    const done = () => {
      if (recovering === attempt) recovering = undefined;
    };
    attempt.then(done, () => setTimeout(done, RECOVERY_COOLDOWN_MS));
  }
  return recovering;
}
/** The token to send once more after a 401 for `sent`, or undefined to stop there. */
async function retryToken(sent: string): Promise<string | undefined> {
  // Refreshed meanwhile (another request or tab): try the new one.
  const now = await currentToken();
  if (now && now !== sent) return now;
  let fresh: string | undefined;
  try {
    fresh = await recoverOnce();
  } catch {
    throw new ApiError(SIGN_IN_UNCHECKED, 503, {});
  }
  if (!fresh) onSessionRejected?.();
  return fresh;
}
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const retryAfterSeconds = (response: Response) => {
  const value = Number(response.headers?.get?.('Retry-After'));
  return Number.isFinite(value) && value > 0 ? value : undefined;
};
export async function api<T>(
  path: string,
  companyId?: string,
  body?: unknown,
  method?: string,
  init: Pick<RequestInit, 'cache'> = {},
): Promise<T> {
  const send = async (sent?: string) => {
    const response = await fetch(`${apiBaseUrl()}/api${path}`, {
      ...init,
      signal: timeoutSignal(45000),
      method: method || (body !== undefined ? 'POST' : 'GET'),
      // Content-Type only with a body: a plain GET then needs no CORS preflight.
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(companyId ? { 'x-company-id': companyId } : {}),
        ...(sent ? { Authorization: `Bearer ${sent}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { response, result: await response.json().catch(() => ({})) };
  };
  const signInBusy = (r: { response: Response; result: { error?: unknown } }) =>
    r.response.status === 503 && r.result.error === SIGN_IN_BUSY;
  let sent = await currentToken();
  let reply = await send(sent);
  // Only the sign-in check answers this, before any change is made, so sending again is safe.
  // Once, after the wait the server asks for (Retry-After is unreadable across origins).
  if (signInBusy(reply)) {
    await wait(Math.min(retryAfterSeconds(reply.response) ?? 5, 10) * 1000);
    sent = await currentToken();
    reply = await send(sent);
  }
  if (reply.response.status === 401 && sent) {
    if (!recoverSession) {
      // Only when the rejected token is still the current one: a request that raced a token
      // refresh must not sign anyone out.
      if (sent === token) onSessionRejected?.();
    } else {
      // Only the sign-in check answers 401, before any change is made, so sending again is safe.
      const fresh = await retryToken(sent);
      if (fresh) {
        sent = fresh;
        reply = await send(sent);
        // A token refreshed a moment ago was refused too: the sign-in is not accepted here.
        // Signing out also ends the loop, since no token is sent after it.
        if (reply.response.status === 401 && sent === (await currentToken())) onSessionRejected?.();
      }
    }
  }
  const { response, result } = reply;
  if (!response.ok)
    throw new ApiError(
      signInBusy(reply)
        ? SIGN_IN_UNCHECKED
        : typeof result.error === 'string'
          ? result.error
          : result.error?.message ||
            result.message ||
            `Request failed (${response.status}). Please try again.`,
      response.status,
      result,
      retryAfterSeconds(response),
    );
  return result as T;
}
