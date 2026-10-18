// The dashboard runs on its own origin, so the API names the response headers it may read: how
// long to wait after a 429 or 503 (Retry-After) and the reference of a failure (X-Request-Id).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../server/app';
import { MemoryRepository } from '../server/repository';

beforeEach(() => {
  vi.stubEnv('APP_MODE', 'demo');
  vi.stubEnv('ORDERLY_RUNTIME', '');
  vi.stubEnv('VERCEL', '');
  vi.stubEnv('APP_URL', 'http://127.0.0.1:5173');
  vi.stubEnv('HEALTH_CHECK_TOKEN', '');
  vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('Unexpected network request'))),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const exposed = (response: Response) =>
  (response.headers.get('access-control-expose-headers') ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase());

describe('cross-origin headers for the dashboard', () => {
  it('lets the dashboard read Retry-After and X-Request-Id', async () => {
    const app = createApp(new MemoryRepository());
    const response = await app.request('http://127.0.0.1:4000/api/health', {
      headers: { Origin: 'http://127.0.0.1:5173' },
    });
    expect(response.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5173');
    expect(exposed(response)).toEqual(expect.arrayContaining(['retry-after', 'x-request-id']));
    expect(response.headers.get('x-request-id')).toBeTruthy();
  });

  it('still refuses another origin', async () => {
    const app = createApp(new MemoryRepository());
    const response = await app.request('http://127.0.0.1:4000/api/health', {
      headers: { Origin: 'https://other.example' },
    });
    expect(response.status).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});
