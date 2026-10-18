import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../server/app';
import { MemoryRepository } from '../server/repository';
import { encryptSecret } from '../server/security';
import { createConversation } from '../src/domain/engine';
import { parseRoute } from '../src/lib/routes';
import { SLUG_RE, slugify } from '../src/shared/slug';
import { seedCompanies } from '../src/shared/seed';
import type { Company } from '../src/shared/types';

const company = seedCompanies[0];
let repo: MemoryRepository;
beforeEach(() => {
  repo = new MemoryRepository();
  vi.stubEnv('APP_MODE', 'demo');
  vi.stubEnv('VERCEL', '');
  vi.stubEnv('ORDERLY_RUNTIME', '');
  vi.stubEnv('APP_URL', 'http://127.0.0.1:5173');
  vi.stubEnv('MODEL_PRICING_JSON', '');
  vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('Unexpected network request'))),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function request(
  path: string,
  options: { body?: unknown; method?: string; companyId?: string } = {},
) {
  return createApp(repo).request(`http://127.0.0.1:4000/api${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers: {
      'Content-Type': 'application/json',
      'x-company-id': options.companyId ?? company.id,
      Origin: 'http://127.0.0.1:5173',
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}
const stored = async (id = company.id) => (await repo.getCompany(id))!;
const audits = async (id = company.id) => (await repo.listTraces(id)).map((t) => t.action);

describe('business slugs', () => {
  it('turns any name into a slug the API and the dashboard links both accept', async () => {
    for (const name of [
      'Pizza & Co.',
      'لذیذ کھانا',
      '@Home Kitchen',
      '(Laziza)',
      'Kababjees (DHA)',
      'Café Délice',
      `${'a'.repeat(69)} b`,
    ]) {
      const created = await request('/companies', { body: { name } });
      expect(created.status, name).toBe(201);
      const business = (await created.json()) as Company;
      expect(business.slug, name).toMatch(SLUG_RE);
      expect(parseRoute(`/app/${business.slug}/orders`).valid, business.slug).toBe(true);
      // The dashboard saves the company back exactly as it received it.
      const saved = await request(`/companies/${business.id}`, {
        method: 'PUT',
        body: business,
        companyId: business.id,
      });
      expect(saved.status, name).toBe(200);
    }
    expect(slugify('لذیذ کھانا')).toBe('business');
    expect(slugify('Café Délice')).toBe('cafe-delice');
    expect(slugify(' Pizza & Co. ')).toBe('pizza-co');
  });

  it('keeps a business with an old malformed slug saveable, and never renames it', async () => {
    await repo.saveCompany({ ...company, slug: 'pizza-co--3f2a9c' });
    const body = { ...(await stored()), botEnabled: false, name: 'Pizza & Co' };
    expect((await request(`/companies/${company.id}`, { method: 'PUT', body })).status).toBe(200);
    expect(
      (
        await request(`/companies/${company.id}`, {
          method: 'PUT',
          body: { ...body, slug: 'something-else' },
        })
      ).status,
    ).toBe(200);
    expect((await stored()).slug).toBe('pizza-co--3f2a9c');
    expect((await stored()).name).toBe('Pizza & Co');
  });
});

describe('company settings keep what the server manages', () => {
  const approval = {
    provider: 'anthropic' as const,
    userId: 'owner-user',
    at: '2026-10-18T08:00:00.000Z',
    version: 'ai-data-terms-2026-10-18',
    noTrainingOptIn: true,
    paidTierAttested: false,
  };
  it('ignores a sent sync time, AI approval, slug and linked-phone permission', async () => {
    await repo.saveCompany({
      ...company,
      botEnabled: false,
      catalogSyncedAt: '2026-10-18T07:00:00.000Z',
      privacy: { aiDataApproved: false, retentionDays: 0 },
    });
    const before = await stored();
    const response = await request(`/companies/${company.id}`, {
      method: 'PUT',
      body: {
        ...before,
        name: 'Renamed kitchen',
        slug: 'taken-over',
        catalogSyncedAt: '2099-01-01T00:00:00.000Z',
        createdAt: '2020-01-01T00:00:00.000Z',
        privacy: { aiDataApproved: true, retentionDays: 30, aiApproval: approval },
        linkedDeviceAllowed: true,
      },
    });
    expect(response.status).toBe(200);
    const after = await stored();
    expect(after.name).toBe('Renamed kitchen');
    expect(after).toMatchObject({
      slug: before.slug,
      catalogSyncedAt: '2026-10-18T07:00:00.000Z',
      createdAt: before.createdAt,
      privacy: { aiDataApproved: false, retentionDays: 0 },
    });
    expect(after.privacy?.aiApproval).toBeUndefined();
    expect(after.linkedDeviceAllowed).toBeUndefined();
  });

  it('keeps the AI approval on an ordinary save and drops it when the provider changes', async () => {
    await repo.saveCompany({
      ...company,
      botEnabled: false,
      ai: { provider: 'anthropic', model: 'claude-haiku-5-5', monthlyBudgetUsd: 10 },
      privacy: { aiDataApproved: true, retentionDays: 0, aiApproval: approval },
    });
    await repo.saveIntegration(
      company.id,
      { kind: 'gemini', configured: true, status: 'connected', config: {} },
      encryptSecret('gemini-test-key-0001'),
    );
    const current = await stored();
    // A dashboard copy without the approval record must not erase it.
    const { privacy: _privacy, ...withoutPrivacy } = current;
    expect(
      (
        await request(`/companies/${company.id}`, {
          method: 'PUT',
          body: { ...withoutPrivacy, name: 'Still approved' },
        })
      ).status,
    ).toBe(200);
    expect((await stored()).privacy).toEqual({
      aiDataApproved: true,
      retentionDays: 0,
      aiApproval: approval,
    });
    const switched = await request(`/companies/${company.id}`, {
      method: 'PUT',
      body: {
        ...current,
        ai: { provider: 'gemini', model: 'gemini-2.5-flash-lite', monthlyBudgetUsd: 10 },
      },
    });
    expect(switched.status).toBe(200);
    expect((await stored()).privacy).toEqual({ aiDataApproved: false, retentionDays: 0 });
    // The model test cannot stand in for the agreement: only Connect and test approves.
    const test = await request('/models/test', { body: {} });
    expect(test.status).toBe(409);
    expect((await test.json()).error).toContain('approve the AI provider data terms');
  });
});

describe('customer data requests', () => {
  async function customer(phone: string) {
    const conversation = createConversation(
      company.id,
      phone,
      'whatsapp',
      new Date().toISOString(),
    );
    conversation.version = 1;
    await repo.saveConversation(conversation, 0);
    return conversation;
  }
  beforeEach(async () => repo.saveCompany({ ...company, botEnabled: false }));

  it('finds and erases a number however the owner types it', async () => {
    const meta = await customer('923001234567');
    const exported = await request(`/privacy/customer?phone=${encodeURIComponent('0300 1234567')}`);
    expect(exported.status).toBe(200);
    expect((await exported.json()).conversations.map((c: { id: string }) => c.id)).toEqual([
      meta.id,
    ]);
    const erased = await request('/privacy/erase', {
      body: { phone: '0300 1234567', externalCopiesAcknowledged: true },
    });
    expect(erased.status).toBe(200);
    expect(await erased.json()).toEqual({ deleted: 1 });
    expect(await repo.getConversation(company.id, meta.id)).toBeUndefined();
    expect(await audits()).toContain('privacy.customer_erased.1');
  });

  it('reaches the linked-phone form of a number (+digits) too', async () => {
    const linked = await customer('+923001234568');
    const erased = await request('/privacy/erase', {
      body: { phone: '+92 300 1234568', externalCopiesAcknowledged: true },
    });
    expect(await erased.json()).toEqual({ deleted: 1 });
    expect(await repo.getConversation(company.id, linked.id)).toBeUndefined();
  });

  it('says so when nothing matched instead of reporting a deletion', async () => {
    await customer('923001234567');
    const message =
      'No records found for this number. Copy the number exactly as shown in the Inbox.';
    const erased = await request('/privacy/erase', {
      body: { phone: '0300 7654321', externalCopiesAcknowledged: true },
    });
    expect(erased.status).toBe(404);
    expect((await erased.json()).error).toBe(message);
    expect(await audits()).toContain('privacy.customer_erased.0');
    const exported = await request('/privacy/customer?phone=03007654321');
    expect(exported.status).toBe(404);
    expect((await exported.json()).error).toBe(message);
    expect(
      (await repo.listConversations(company.id)).some((c) => c.customerPhone === '923001234567'),
    ).toBe(true);
  });
});
