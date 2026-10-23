import { env, requiredEnv } from '../config.js';
import { PublicError, logFailure } from '../security.js';

// "Connect with Google" for a restaurant's order Sheet. The owner signs in to Google in a popup
// (Google Identity Services, code model) and allows only drive.file: Orderly may create files
// in the owner's Drive and open those, and no other file. The code from the popup is exchanged
// here for a refresh token, stored encrypted like a key file, and every Sheets call later asks
// Google for a short-lived access token with it.

/** The one scope asked for: files Orderly creates or is given, nothing else in the Drive. */
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
/** The code on errors that need the owner to connect Google again; the dashboard acts on it. */
export const GOOGLE_REAUTH = 'GOOGLE_REAUTH';
export const REAUTH_MESSAGE =
  'Google stopped Orderly’s access to your Sheet (it was removed in your Google Account, or not used for six months). Click Reconnect Google in Integrations → Google Sheets.';

/**
 * Whether owners see the button: the OAuth client is set, and GOOGLE_SHEETS_CONNECT=off is the
 * switch that hides it again without touching connections already made.
 */
export function googleConnectEnabled(): boolean {
  return (
    !!env('GOOGLE_OAUTH_CLIENT_ID') &&
    !!env('GOOGLE_OAUTH_CLIENT_SECRET') &&
    (env('GOOGLE_SHEETS_CONNECT') ?? '').trim().toLowerCase() !== 'off'
  );
}

interface TokenAnswer {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
}
async function tokenRequest(params: Record<string, string>): Promise<TokenAnswer> {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: requiredEnv('GOOGLE_OAUTH_CLIENT_ID'),
      client_secret: requiredEnv('GOOGLE_OAUTH_CLIENT_SECRET'),
      ...params,
    }),
    signal: AbortSignal.timeout(10000),
  });
  return ((await response.json().catch(() => ({}))) ?? {}) as TokenAnswer;
}

/**
 * The tokens for a code from the popup. A popup's code is commonly redeemed with redirect_uri
 * "postmessage", while Google's guide names the dashboard's origin; GOOGLE_OAUTH_REDIRECT_URI
 * sets the other value should Google refuse this one (redirect_uri_mismatch in the log).
 */
export async function exchangeCode(code: string) {
  const answer = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: env('GOOGLE_OAUTH_REDIRECT_URI') || 'postmessage',
  });
  if (!answer.access_token) {
    const failure = new PublicError(
      answer.error === 'invalid_grant'
        ? 'Google’s sign-in ran out before Orderly could use it. Click Connect with Google again.'
        : 'Google didn’t accept the sign-in. Click Connect with Google again.',
      502,
    );
    // Google's error code only (such as redirect_uri_mismatch), for the operator.
    logFailure(
      'google_code_exchange',
      { googleError: String(answer.error ?? 'no_access_token').slice(0, 60) },
      failure,
    );
    throw failure;
  }
  return {
    accessToken: answer.access_token,
    refreshToken: answer.refresh_token,
    scopes: (answer.scope ?? '').split(' ').filter(Boolean),
  };
}

// Access tokens by refresh token, until a minute or two before Google's expiry: one order sync
// or menu refresh makes several Sheets calls, and each would otherwise ask Google again.
const accessTokens = new Map<string, { token: string; until: number }>();
/** A short-lived access token for a stored refresh token. */
export async function googleAccessToken(refreshToken: string): Promise<string> {
  const cached = accessTokens.get(refreshToken);
  if (cached && cached.until > Date.now()) return cached.token;
  const answer = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
  // invalid_grant: the owner removed Orderly, the token went unused for six months, or Google
  // ended it for another reason. Only connecting again helps.
  if (answer.error === 'invalid_grant')
    throw new PublicError(REAUTH_MESSAGE, 400, { code: GOOGLE_REAUTH });
  if (!answer.access_token)
    throw new PublicError('Google didn’t answer Orderly. It will try again shortly.', 502);
  const seconds = Number(answer.expires_in) > 0 ? Number(answer.expires_in) : 3600;
  if (accessTokens.size >= 500) accessTokens.delete(accessTokens.keys().next().value!);
  accessTokens.set(refreshToken, {
    token: answer.access_token,
    until: Date.now() + Math.max(0, seconds - 120) * 1000,
  });
  return answer.access_token;
}
/** Drops a cached access token Google has refused (401), so the next call asks afresh. */
export function forgetGoogleAccessToken(refreshToken: string) {
  accessTokens.delete(refreshToken);
}

/**
 * Ends Orderly's access for the Google account that granted this token. Google ends the whole
 * grant, for every token of that account, so callers check no other business still uses it.
 * True when Google confirms, or the token was already invalid; never throws.
 */
export async function revokeGoogleToken(token: string): Promise<boolean> {
  accessTokens.delete(token);
  try {
    const response = await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(5000),
    });
    return response.ok || response.status === 400;
  } catch {
    return false;
  }
}

/** Google's short reason for a refused API call (SERVICE_DISABLED, PERMISSION_DENIED…), for logs. */
export function googleReason(body: unknown): string {
  const error = (body as { error?: { status?: unknown; details?: { reason?: unknown }[] } })?.error;
  const reason = Array.isArray(error?.details) ? error.details[0]?.reason : undefined;
  return String(reason ?? error?.status ?? 'unknown').slice(0, 60);
}

/**
 * The Google account that signed in: its stable id (Drive's permissionId) and email. Drive's
 * about.get accepts drive.file, so this needs no extra permission from the owner.
 */
export async function googleAccount(accessToken: string): Promise<{ id: string; email?: string }> {
  const response = await fetch(
    'https://www.googleapis.com/drive/v3/about?fields=user(permissionId,emailAddress)',
    { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10000) },
  );
  const body = (await response.json().catch(() => ({}))) as {
    user?: { permissionId?: unknown; emailAddress?: unknown };
  };
  const id = typeof body.user?.permissionId === 'string' ? body.user.permissionId : '';
  if (!response.ok || !id) {
    const failure = new PublicError(
      'Orderly couldn’t tell which Google account you used. Try again in a minute.',
      502,
    );
    // Such as 403 SERVICE_DISABLED: the Drive API is off in Orderly's Google project.
    logFailure('google_account', { status: response.status, reason: googleReason(body) }, failure);
    throw failure;
  }
  const email = typeof body.user?.emailAddress === 'string' ? body.user.emailAddress : undefined;
  return { id, ...(email && { email }) };
}
