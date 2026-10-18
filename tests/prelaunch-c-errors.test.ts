import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app';
import { MemoryRepository } from '../server/repository';
import { createConversation, processTurn } from '../src/domain/engine';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import type { BotAction } from '../src/shared/types';

const auth = vi.hoisted(() => ({ getUser: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ auth: { getUser: auth.getUser } }),
}));

const company = seedCompanies[0];
const other = seedCompanies[1];
let repo: MemoryRepository;
beforeEach(() => {
  repo = new MemoryRepository();
  vi.stubEnv('APP_MODE', 'demo');
  vi.stubEnv('VERCEL', '');
  vi.stubEnv('ORDERLY_RUNTIME', '');
  vi.stubEnv('APP_URL', 'http://127.0.0.1:5173');
  vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('Unexpected network request'))),
  );
  auth.getUser.mockReset();
  auth.getUser.mockResolvedValue({ data: { user: { id: 'owner-user' } }, error: null });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function request(path: string, options: { body?: unknown; raw?: string; companyId?: string } = {}) {
  return createApp(repo).request(`http://127.0.0.1:4000/api${path}`, {
    method: options.body === undefined && options.raw === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-company-id': options.companyId ?? company.id,
      Origin: 'http://127.0.0.1:5173',
      Authorization: 'Bearer header.eyJhbGciOiJIUzI1NiJ9.signature',
    },
    ...(options.raw !== undefined
      ? { body: options.raw }
      : options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
  });
}
const live = () => {
  vi.stubEnv('APP_MODE', 'live');
  vi.spyOn(repo, 'listAllowedCompanies').mockResolvedValue([company]);
  vi.spyOn(repo, 'getRole').mockResolvedValue('owner');
};

describe('server errors', () => {
  it('logs one line for an unexpected failure and returns a reference, with no secrets', async () => {
    live();
    vi.spyOn(repo, 'listProducts').mockRejectedValue(
      new Error(
        'Database operation failed: token eyJhbGciOiJIUzI1NiJ9.payload.sig sk-ant-api03-abcdefgh',
      ),
    );
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await request('/bootstrap');
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe(
      'The service could not complete this request. Check the connection and try again.',
    );
    expect(body.requestId).toMatch(/^[\w-]{8,}$/);
    expect(log).toHaveBeenCalledOnce();
    const line = String(log.mock.calls[0]![0]);
    expect(JSON.parse(line)).toMatchObject({
      event: 'request_failed',
      method: 'GET',
      route: '/api/bootstrap',
      name: 'Error',
      requestId: body.requestId,
    });
    expect(line).toContain('Database operation failed');
    expect(line).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(line).not.toContain('sk-ant-api03');
    expect(line).not.toContain('signature');
  });

  it('answers a body that is not JSON with 400, not a server error', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await request('/chat', { raw: '{bad' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Request body must be valid JSON.' });
    expect(log).not.toHaveBeenCalled();
  });

  it('shows order rule messages but never database text when an order status change fails', async () => {
    let conversation = createConversation(
      company.id,
      '923001234567',
      'demo',
      new Date().toISOString(),
    );
    const turn = (action: BotAction) => {
      const result = processTurn(
        company,
        seedProducts.filter((p) => p.companyId === company.id),
        conversation,
        {
          messageId: randomUUID(),
          text: action.type === 'confirm' ? 'confirm' : 'test',
          action,
          now: new Date().toISOString(),
        },
      );
      conversation = result.conversation;
      return result;
    };
    turn({ type: 'add_item', productId: seedProducts[0].id, quantity: 1 });
    turn({ type: 'set_details', customerName: 'Status Test', fulfillment: 'pickup' });
    turn({ type: 'review' });
    const { order } = turn({ type: 'confirm' });
    conversation.version = 1;
    await repo.commitTurn(company.id, conversation, 0, order);
    const invalid = await request(`/orders/${order!.id}/status`, { body: { status: 'completed' } });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error).toBe('Cannot change pending to completed.');
    vi.spyOn(repo, 'updateOrderStatus').mockRejectedValue(
      new Error('Database operation failed: canceling statement due to statement timeout'),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const failed = await request(`/orders/${order!.id}/status`, { body: { status: 'rejected' } });
    expect(failed.status).toBe(500);
    expect(JSON.stringify(await failed.json())).not.toContain('statement timeout');
  });
});

describe('sign-in checks', () => {
  it.each([
    ['a network failure', { name: 'AuthRetryableFetchError', status: 0, message: 'fetch failed' }],
    ['an Auth server error', { name: 'AuthRetryableFetchError', status: 503, message: 'down' }],
    ['a 500 from Auth', { name: 'AuthApiError', status: 500, message: 'internal' }],
    ['rate limiting', { name: 'AuthApiError', status: 429, message: 'slow down' }],
  ])('answers %s with 503 so the dashboard keeps the session', async (_case, error) => {
    live();
    auth.getUser.mockResolvedValue({ data: { user: null }, error });
    const response = await request('/bootstrap');
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');
    expect((await response.json()).error).toBe('Sign-in service is busy, please retry.');
  });
  it('treats a thrown sign-in check as busy too', async () => {
    live();
    auth.getUser.mockRejectedValue(new TypeError('fetch failed'));
    expect((await request('/bootstrap')).status).toBe(503);
  });
  it.each([
    ['an expired token', { name: 'AuthApiError', status: 401, message: 'JWT expired' }],
    ['a bad token', { name: 'AuthApiError', status: 403, code: 'bad_jwt', message: 'bad' }],
    ['a missing session', { name: 'AuthSessionMissingError', status: 400, message: 'missing' }],
    ['an unknown rejection', { message: 'invalid' }],
  ])('still signs out on %s', async (_case, error) => {
    live();
    auth.getUser.mockResolvedValue({ data: { user: null }, error });
    const response = await request('/bootstrap');
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe('Your session expired. Sign in again.');
  });
});

describe('test chat limit', () => {
  it('allows 15 test messages a minute per business before any AI work', async () => {
    const chat = (companyId = company.id) =>
      request('/chat', {
        companyId,
        body: { messageId: randomUUID(), text: 'menu', action: { type: 'menu' } },
      });
    for (let i = 0; i < 15; i++) expect((await chat()).status).toBe(200);
    const before = (await repo.listConversations(company.id)).length;
    const limited = await chat();
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    expect((await limited.json()).error).toBe('Too many test messages. Please wait a minute.');
    expect((await repo.listConversations(company.id)).length).toBe(before);
    // Another business is not slowed down by this one.
    expect((await chat(other.id)).status).toBe(200);
  });
});
