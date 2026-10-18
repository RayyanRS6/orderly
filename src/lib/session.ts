// How the dashboard keeps a Supabase sign-in alive for its API requests. Kept apart from App.tsx
// so it can be tested with a stand-in auth client, and from api.ts so the public menu page never
// loads it.

type AuthResult = {
  data: { session: { access_token: string } | null };
  error: unknown;
};
/** The parts of the Supabase auth client used here. */
export interface SessionAuth {
  getSession(): Promise<AuthResult>;
  refreshSession(): Promise<AuthResult>;
}

// Refresh failures that mean the sign-in is gone for good: revoked or signed out elsewhere,
// expired, or the account deleted or banned. Anything else (offline, the sign-in service busy or
// rate limited, an unknown error) keeps the session, because it may still work.
const ENDED = new Set([
  'refresh_token_not_found',
  'refresh_token_already_used',
  'session_not_found',
  'session_expired',
  'invalid_grant',
  'user_not_found',
  'user_banned',
]);
export function signInEnded(error: unknown): boolean {
  const e = error as { name?: unknown; code?: unknown; message?: unknown } | null;
  if (!e || typeof e !== 'object') return false;
  // Nothing saved to refresh, or the server no longer has the session.
  if (e.name === 'AuthSessionMissingError') return true;
  if (e.name !== 'AuthApiError') return false;
  if (typeof e.code === 'string') return ENDED.has(e.code);
  // Older Auth servers answer without a code.
  return typeof e.message === 'string' && /invalid refresh token|invalid grant/i.test(e.message);
}

/** The token source and recovery for api.ts (setAccessTokenSource, setSessionRecovery). */
export function sessionHooks(auth: SessionAuth) {
  return {
    // getSession refreshes a token that is about to expire, even in a hidden tab.
    token: async () => (await auth.getSession()).data.session?.access_token,
    recover: async () => {
      const { data, error } = await auth.refreshSession();
      if (data.session) return data.session.access_token;
      if (signInEnded(error)) return undefined;
      throw error instanceof Error ? error : new Error('The sign-in could not be refreshed.');
    },
  };
}
