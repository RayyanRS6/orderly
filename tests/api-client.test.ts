import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, setAccessToken, setSessionRejectedHandler } from '../src/lib/api';

afterEach(() => {
  setAccessToken();
  setSessionRejectedHandler();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('frontend API routing', () => {
  it('preserves the local Vite API proxy when no backend URL is configured', async () => {
    vi.stubEnv('VITE_API_BASE_URL', '');
    const fetch = vi.fn(async () => Response.json({ mode: 'demo' }));
    vi.stubGlobal('fetch', fetch);
    await expect(api('/config')).resolves.toEqual({ mode: 'demo' });
    expect(fetch).toHaveBeenCalledWith('/api/config', expect.objectContaining({ method: 'GET' }));
  });

  it('routes authenticated company requests to the configured Supabase function', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://project.supabase.co/functions/v1/orderly/');
    setAccessToken('test-access-token');
    const fetch = vi.fn(async () => Response.json({ saved: true }));
    vi.stubGlobal('fetch', fetch);
    await api('/orders', 'company-one', { note: 'No onions' });
    expect(fetch).toHaveBeenCalledWith(
      'https://project.supabase.co/functions/v1/orderly/api/orders',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-access-token',
          'x-company-id': 'company-one',
        }),
        body: JSON.stringify({ note: 'No onions' }),
      }),
    );
  });

  it.each([
    '/functions/v1/orderly',
    '//project.supabase.co/functions/v1/orderly',
    'http://project.supabase.co/functions/v1/orderly',
    'https://user:password@project.supabase.co/functions/v1/orderly',
    'https://project.supabase.co/functions/v1/orderly?key=secret',
    'https://project.supabase.co/functions/v1/orderly#fragment',
    'javascript:alert(1)',
  ])('refuses an unsafe configured destination before sending credentials: %s', async (base) => {
    vi.stubEnv('VITE_API_BASE_URL', base);
    setAccessToken('test-access-token');
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(api('/account')).rejects.toThrow('VITE_API_BASE_URL must be');
    expect(fetch).not.toHaveBeenCalled();
  });

  describe('a saved session the server no longer accepts', () => {
    const rejected = () =>
      Response.json({ error: 'Your session expired. Sign in again.' }, { status: 401 });

    it('reports it, so the app can sign out locally and show the sign-in form', async () => {
      vi.stubEnv('VITE_API_BASE_URL', '');
      setAccessToken('revoked-token');
      const handler = vi.fn();
      setSessionRejectedHandler(handler);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => rejected()),
      );
      await expect(api('/bootstrap')).rejects.toThrow('Your session expired. Sign in again.');
      expect(handler).toHaveBeenCalledOnce();
    });

    it('ignores a 401 when no sign-in was sent', async () => {
      vi.stubEnv('VITE_API_BASE_URL', '');
      const handler = vi.fn();
      setSessionRejectedHandler(handler);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => rejected()),
      );
      await expect(api('/bootstrap')).rejects.toThrow();
      expect(handler).not.toHaveBeenCalled();
    });

    it('ignores a 401 for a token that was refreshed while the request was in flight', async () => {
      vi.stubEnv('VITE_API_BASE_URL', '');
      setAccessToken('old-token');
      const handler = vi.fn();
      setSessionRejectedHandler(handler);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          setAccessToken('fresh-token');
          return rejected();
        }),
      );
      await expect(api('/activity')).rejects.toThrow();
      expect(handler).not.toHaveBeenCalled();
    });

    it('ignores other failures, such as a missing authenticator check', async () => {
      vi.stubEnv('VITE_API_BASE_URL', '');
      setAccessToken('valid-token');
      const handler = vi.fn();
      setSessionRejectedHandler(handler);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          Response.json({ error: 'Complete authenticator verification.' }, { status: 403 }),
        ),
      );
      await expect(api('/bootstrap')).rejects.toThrow('Complete authenticator verification.');
      expect(handler).not.toHaveBeenCalled();
    });
  });

  it.each(['http://localhost:4000', 'http://127.0.0.1:4000', 'http://[::1]:4000'])(
    'allows an explicit loopback backend for local testing: %s',
    async (base) => {
      vi.stubEnv('VITE_API_BASE_URL', base);
      const fetch = vi.fn(async () => Response.json({ mode: 'demo' }));
      vi.stubGlobal('fetch', fetch);
      await api('/config');
      expect(fetch).toHaveBeenCalledWith(
        `${base}/api/config`,
        expect.objectContaining({ method: 'GET' }),
      );
    },
  );
});
