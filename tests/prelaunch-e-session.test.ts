import { afterEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  api,
  ApiError,
  setAccessToken,
  setAccessTokenSource,
  setSessionRecovery,
  setSessionRejectedHandler,
  SIGN_IN_UNCHECKED,
  timeoutSignal,
} from '../src/lib/api';
import { sessionHooks, signInEnded } from '../src/lib/session';

afterEach(() => {
  setAccessToken();
  setAccessTokenSource();
  setSessionRecovery();
  setSessionRejectedHandler();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const expired = () =>
  Response.json({ error: 'Your session expired. Sign in again.' }, { status: 401 });
const busy = () =>
  Response.json(
    { error: 'Sign-in service is busy, please retry.' },
    { status: 503, headers: { 'Retry-After': '5' } },
  );
const authOf = (init: RequestInit) => (init.headers as Record<string, string>).Authorization;
// The server accepts only `good`; every other token gets a 401.
const server = (good: string) =>
  vi.fn(async (_url: string, init: RequestInit) =>
    authOf(init) === `Bearer ${good}` ? Response.json({ ok: true }) : expired(),
  );

describe('a sign-in that expired while the tab was in the background', () => {
  it('sends the token the auth client holds now, not the one saved at sign-in', async () => {
    vi.stubEnv('VITE_API_BASE_URL', '');
    setAccessToken('from-sign-in');
    let current = 'refreshed-1';
    setAccessTokenSource(async () => current);
    const fetch = server('refreshed-2');
    vi.stubGlobal('fetch', fetch);
    current = 'refreshed-2';
    await expect(api('/attention', 'company-one')).resolves.toEqual({ ok: true });
    expect(authOf(fetch.mock.calls[0]![1])).toBe('Bearer refreshed-2');
  });

  it('refreshes once on a 401, sends the request again and signs nobody out', async () => {
    vi.stubEnv('VITE_API_BASE_URL', '');
    setAccessTokenSource(async () => 'stale');
    const recover = vi.fn(async () => 'fresh');
    setSessionRecovery(recover);
    const rejected = vi.fn();
    setSessionRejectedHandler(rejected);
    const fetch = server('fresh');
    vi.stubGlobal('fetch', fetch);
    await expect(api('/orders/1/status', 'company-one', { status: 'accepted' })).resolves.toEqual({
      ok: true,
    });
    expect(recover).toHaveBeenCalledOnce();
    expect(rejected).not.toHaveBeenCalled();
    // The change is sent again once, with the fresh token and the same body.
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(authOf(fetch.mock.calls[1]![1])).toBe('Bearer fresh');
    expect(fetch.mock.calls[1]![1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ status: 'accepted' }),
    });
  });

  it('shares one refresh among requests rejected together', async () => {
    vi.stubEnv('VITE_API_BASE_URL', '');
    let current = 'stale';
    setAccessTokenSource(async () => current);
    let finish!: (token: string) => void;
    const recover = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = (token) => {
            current = token;
            resolve(token);
          };
        }),
    );
    setSessionRecovery(recover);
    vi.stubGlobal('fetch', server('fresh'));
    const requests = ['/attention', '/activity', '/bootstrap', '/orders'].map((path) =>
      api(path, 'company-one'),
    );
    await vi.waitFor(() => expect(recover).toHaveBeenCalled());
    finish('fresh');
    await expect(Promise.all(requests)).resolves.toHaveLength(4);
    expect(recover).toHaveBeenCalledOnce();
  });

  it('signs out once when the refresh says the sign-in is gone', async () => {
    vi.stubEnv('VITE_API_BASE_URL', '');
    setAccessTokenSource(async () => 'revoked');
    const recover = vi.fn(async () => undefined);
    setSessionRecovery(recover);
    const rejected = vi.fn();
    setSessionRejectedHandler(rejected);
    const fetch = server('never');
    vi.stubGlobal('fetch', fetch);
    await expect(api('/bootstrap')).rejects.toThrow('Your session expired. Sign in again.');
    expect(rejected).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('keeps the sign-in when the refresh could not be checked, and stops asking for a while', async () => {
    vi.stubEnv('VITE_API_BASE_URL', '');
    setAccessTokenSource(async () => 'stale');
    const recover = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    setSessionRecovery(recover);
    const rejected = vi.fn();
    setSessionRejectedHandler(rejected);
    vi.stubGlobal('fetch', server('never'));
    const error = (await api('/attention').catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toBe(SIGN_IN_UNCHECKED);
    expect(error.status).toBe(503);
    await expect(api('/activity')).rejects.toThrow(SIGN_IN_UNCHECKED);
    // Polls right after a failed check reuse it instead of asking the sign-in service again.
    expect(recover).toHaveBeenCalledOnce();
    expect(rejected).not.toHaveBeenCalled();
  });

  it('signs out when even a token refreshed a moment ago is refused, without trying again', async () => {
    vi.stubEnv('VITE_API_BASE_URL', '');
    let current = 'stale';
    setAccessTokenSource(async () => current);
    const recover = vi.fn(async () => (current = 'fresh'));
    setSessionRecovery(recover);
    const rejected = vi.fn();
    setSessionRejectedHandler(rejected);
    const fetch = server('never');
    vi.stubGlobal('fetch', fetch);
    await expect(api('/bootstrap')).rejects.toThrow('Your session expired.');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(recover).toHaveBeenCalledOnce();
    expect(rejected).toHaveBeenCalledOnce();
  });

  it('never signs out while the sign-in service is busy, and asks once more after its wait', async () => {
    vi.useFakeTimers();
    vi.stubEnv('VITE_API_BASE_URL', '');
    setAccessTokenSource(async () => 'valid');
    const recover = vi.fn(async () => 'fresh');
    setSessionRecovery(recover);
    const rejected = vi.fn();
    setSessionRejectedHandler(rejected);
    const fetch = vi.fn(async () => busy());
    vi.stubGlobal('fetch', fetch);
    const request = api('/bootstrap').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5000);
    const error = (await request) as ApiError;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(error.status).toBe(503);
    expect(error.message).toBe(SIGN_IN_UNCHECKED);
    expect(recover).not.toHaveBeenCalled();
    expect(rejected).not.toHaveBeenCalled();

    fetch
      .mockImplementationOnce(async () => busy())
      .mockImplementationOnce(async () => Response.json({ ok: true }));
    const retried = api('/activity');
    await vi.advanceTimersByTimeAsync(5000);
    await expect(retried).resolves.toEqual({ ok: true });
  });

  it('shows other 503 answers as they are, without waiting', async () => {
    vi.stubEnv('VITE_API_BASE_URL', '');
    const fetch = vi.fn(async () =>
      Response.json(
        { error: 'The linked-phone service is restarting. Nothing was changed.' },
        { status: 503 },
      ),
    );
    vi.stubGlobal('fetch', fetch);
    await expect(api('/whatsapp/pair', 'c', {})).rejects.toThrow('linked-phone service');
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe('the Supabase sign-in hooks', () => {
  const result = (session: { access_token: string } | null, error: unknown = null) => ({
    data: { session },
    error,
  });

  it('reads the current access token and refreshes on request', async () => {
    const auth = {
      getSession: vi.fn(async () => result({ access_token: 'current' })),
      refreshSession: vi.fn(async () => result({ access_token: 'fresh' })),
    };
    const hooks = sessionHooks(auth);
    await expect(hooks.token()).resolves.toBe('current');
    await expect(hooks.recover()).resolves.toBe('fresh');
  });

  it.each([
    { name: 'AuthApiError', code: 'refresh_token_not_found', status: 400 },
    { name: 'AuthApiError', code: 'refresh_token_already_used', status: 400 },
    { name: 'AuthApiError', code: 'session_expired', status: 403 },
    { name: 'AuthApiError', code: 'user_banned', status: 403 },
    { name: 'AuthApiError', message: 'Invalid Refresh Token: Refresh Token Not Found' },
    { name: 'AuthSessionMissingError', message: 'Auth session missing!' },
  ])('treats $name $code$message as a sign-in that is gone', async (error) => {
    expect(signInEnded(error)).toBe(true);
    const hooks = sessionHooks({
      getSession: async () => result(null),
      refreshSession: async () => result(null, error),
    });
    await expect(hooks.recover()).resolves.toBeUndefined();
  });

  it.each([
    { name: 'AuthRetryableFetchError', message: 'Failed to fetch', status: 0 },
    { name: 'AuthRetryableFetchError', message: 'Service unavailable', status: 503 },
    { name: 'AuthApiError', code: 'over_request_rate_limit', status: 429 },
    { name: 'AuthRefreshDiscardedError', message: 'discarded', status: 409 },
    { name: 'AuthUnknownError', message: 'Unexpected' },
  ])('keeps the sign-in after $name $code$message', async (error) => {
    expect(signInEnded(error)).toBe(false);
    const hooks = sessionHooks({
      getSession: async () => result(null),
      refreshSession: async () => result(null, error),
    });
    await expect(hooks.recover()).rejects.toBeTruthy();
  });
});

describe('request time limits on older phones', () => {
  it('falls back to a timer where AbortSignal.timeout is missing', async () => {
    vi.useFakeTimers();
    const RealAbortSignal = AbortSignal;
    vi.stubGlobal('AbortSignal', { prototype: RealAbortSignal.prototype });
    const signal = timeoutSignal(45000);
    expect(signal).toBeInstanceOf(RealAbortSignal);
    expect(signal.aborted).toBe(false);
    vi.advanceTimersByTime(45000);
    expect(signal.aborted).toBe(true);
  });

  it('still sends every request where AbortSignal.timeout is missing', async () => {
    vi.stubEnv('VITE_API_BASE_URL', '');
    const RealAbortSignal = AbortSignal;
    vi.stubGlobal('AbortSignal', { prototype: RealAbortSignal.prototype });
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetch);
    await expect(api('/public/menu/dastarkhwan')).resolves.toEqual({ ok: true });
    expect(fetch.mock.calls[0]![1].signal).toBeInstanceOf(RealAbortSignal);
  });
});

describe('signing out', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
    });
  const sources = files(join(process.cwd(), 'src')).map((path) => ({
    path: path.replaceAll('\\', '/'),
    text: readFileSync(path, 'utf8'),
  }));

  it('ends only this device’s session, except for “Sign out all sessions”', () => {
    // Supabase's default scope is global: it would also sign out the kitchen phone.
    for (const { path, text } of sources) expect(text, path).not.toMatch(/\.signOut\(\s*\)/);
    const global = sources.filter(({ text }) => /signOut\(\{\s*scope:\s*'global'/.test(text));
    expect(global.map(({ path }) => path.split('/src/')[1])).toEqual(['components/Operations.tsx']);
    const operations = sources.find(({ path }) => path.endsWith('components/Operations.tsx'))!;
    expect(operations.text).toMatch(
      /signOut\(\{ scope: 'global' \}\)\}\s*>\s*Sign out all sessions/,
    );
    const app = sources.find(({ path }) => path.endsWith('/src/App.tsx'))!;
    expect(app.text.match(/signOutHere\(client\)/g)).toHaveLength(3);
    expect(app.text).toContain("return client.auth.signOut({ scope: 'local' });");
  });
});
