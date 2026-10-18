// FX-5a (5): an unexpected server failure names the reference of its log line in the dashboard's
// message, and the client reads Retry-After and X-Request-Id when the browser can see them.
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../server/app';
import { api, ApiError, withReference } from '../src/lib/api';
import { company, demoApp } from './helpers/demo-app';

const app = demoApp();
const failing = (body: unknown, headers: Record<string, string> = {}, status = 500) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(body, { status, headers })),
  );

describe('FX-5a: request references in error messages', () => {
  it('adds the server’s reference to an unexpected failure', async () => {
    vi.stubEnv('VITE_API_BASE_URL', '');
    failing({ error: 'The service could not complete this request.', requestId: 'req-1234abcd' });
    const error = (await api('/bootstrap', company.id).catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toBe(
      'The service could not complete this request. Reference: req-1234abcd',
    );
    expect(error.requestId).toBe('req-1234abcd');
    expect(error.status).toBe(500);
  });

  it('keeps expected refusals and the public menu page’s words as they are', async () => {
    vi.stubEnv('VITE_API_BASE_URL', '');
    // An ordinary refusal has no reference in its body; the header is kept for callers.
    failing({ error: 'Menu item not found.' }, { 'X-Request-Id': 'req-header-1' }, 404);
    const refused = (await api('/products', company.id, {}).catch((e: unknown) => e)) as ApiError;
    expect(refused.message).toBe('Menu item not found.');
    expect(refused.requestId).toBe('req-header-1');
    // Customers on the menu page see the page's own words.
    failing({ error: 'Something went wrong. Please try again in a moment.', requestId: 'req-9' });
    const menu = (await api('/public/menu/x').catch((e: unknown) => e)) as ApiError;
    expect(menu.message).toBe('Something went wrong. Please try again in a moment.');
    expect(menu.requestId).toBe('req-9');
    expect(withReference('Failed.', '/orders', { requestId: '  ' })).toBe('Failed.');
    expect(withReference('Failed.', '/orders', { requestId: 42 })).toBe('Failed.');
  });

  it('reads Retry-After when the server sends it', async () => {
    vi.stubEnv('VITE_API_BASE_URL', '');
    failing({ error: 'Too many requests. Please wait a minute.' }, { 'Retry-After': '60' }, 429);
    const error = (await api('/whatsapp/pairing-status', company.id, {}).catch(
      (e: unknown) => e,
    )) as ApiError;
    expect(error.retryAfter).toBe(60);
    expect(error.message).toBe('Too many requests. Please wait a minute.');
  });

  it('names the same reference as the server’s log line for a real failure', async () => {
    vi.stubEnv('VITE_API_BASE_URL', '');
    vi.spyOn(app.repo(), 'listProducts').mockRejectedValue(new Error('Database operation failed'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) =>
        createApp(app.repo()).request(`http://127.0.0.1:4000${url}`, init),
      ),
    );
    const error = (await api('/bootstrap', company.id).catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(500);
    expect(error.requestId).toMatch(/^[\w-]{8,}$/);
    expect(error.message).toBe(
      `The service could not complete this request. Check the connection and try again. Reference: ${error.requestId}`,
    );
    const logged = JSON.parse(String(vi.mocked(console.error).mock.calls[0]![0]));
    expect(logged.requestId).toBe(error.requestId);
  });
});
