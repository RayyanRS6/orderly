import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../server/app';
import { MemoryRepository } from '../server/repository';
import { encryptSecret } from '../server/security';
import { modelDefaults, validateModelConfiguration } from '../server/integrations/models';
import { seedCompanies } from '../src/shared/seed';
import type { Company, Integration, Provider } from '../src/shared/types';

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'signed-in-owner' } }, error: null }) },
  }),
}));

let repo: MemoryRepository;
let company: Company;
// Each provider's old server-wide key name: Orderly no longer reads these.
const providers = [
  [
    'gemini',
    'GOOGLE_API_KEY',
    'x-goog-api-key',
    'https://generativelanguage.googleapis.com/v1beta/models',
  ],
  ['openai', 'OPENAI_API_KEY', 'Authorization', 'https://api.openai.com/v1/models'],
  ['anthropic', 'ANTHROPIC_API_KEY', 'x-api-key', 'https://api.anthropic.com/v1/models'],
] as const;

beforeEach(() => {
  repo = new MemoryRepository();
  company = structuredClone(seedCompanies[0]);
  vi.spyOn(repo, 'isAdmin').mockResolvedValue(false);
  vi.spyOn(repo, 'getRole').mockResolvedValue('owner');
  vi.spyOn(repo, 'listAllowedCompanies').mockImplementation(() => repo.listCompanies());
  vi.stubEnv('APP_MODE', 'live');
  vi.stubEnv('ORDERLY_RUNTIME', '');
  vi.stubEnv('VERCEL', '');
  vi.stubEnv('APP_URL', 'http://127.0.0.1:5173');
  vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  // A server-wide key must never answer for a business.
  for (const [, env] of providers) vi.stubEnv(env, 'server-env-key');
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

async function select(provider: Provider, extra: Record<string, unknown> = {}) {
  company = {
    ...company,
    ai: { ...company.ai, ...extra, provider, model: modelDefaults[provider] },
  };
  await repo.saveCompany(company);
}

async function saveOwn(kind: 'openai' | 'anthropic' | 'gemini') {
  const integration: Integration = { kind, configured: true, status: 'configured', config: {} };
  await repo.saveIntegration(company.id, integration, encryptSecret('business-test-key'));
  return integration;
}

function request(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  return createApp(repo).request(`http://127.0.0.1/api${path}`, {
    method,
    headers: {
      Authorization: 'Bearer test-owner-session',
      'x-company-id': company.id,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('selected model connection readiness and key tests', () => {
  it('accepts the current Gemini default without a pricing override', async () => {
    await select('gemini');
    vi.stubEnv('MODEL_PRICING_JSON', '');
    expect(company.ai.model).toBe('gemini-3.5-flash-lite');
    expect(() => validateModelConfiguration(company)).not.toThrow();
  });

  it.each(providers)(
    'tests %s with the business’s own key, never a server key',
    async (kind, _env, header, url) => {
      await select(kind);
      await saveOwn(kind);
      const bootstrap = await (await request('/bootstrap')).json();
      expect(bootstrap.aiConnection).toEqual({ provider: kind, configured: true });
      expect(JSON.stringify(bootstrap)).not.toContain('business-test-key');
      expect(JSON.stringify(bootstrap)).not.toContain('server-env-key');
      vi.mocked(fetch).mockResolvedValueOnce(Response.json({ data: [] }));
      const response = await request(`/integrations/${kind}/test`, {});
      expect(response.status).toBe(200);
      expect(fetch).toHaveBeenCalledWith(
        url,
        expect.objectContaining({
          headers: expect.objectContaining({
            [header]: kind === 'openai' ? 'Bearer business-test-key' : 'business-test-key',
          }),
        }),
      );
      expect((await repo.getIntegrations(company.id))[0].status).toBe('connected');
    },
  );

  it('ignores an Orderly-key setting left in older saved data', async () => {
    await select('gemini', { keyMode: 'platform' });
    await saveOwn('gemini');
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ models: [] }));
    expect((await request('/integrations/gemini/test', {})).status).toBe(200);
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: { 'x-goog-api-key': 'business-test-key' } }),
    );
  });

  it('reports a missing business key instead of falling back to a server key', async () => {
    await select('gemini');
    expect((await (await request('/bootstrap')).json()).aiConnection.configured).toBe(false);
    expect((await request('/integrations/gemini/test', {})).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('accepts settings from an older dashboard that still sends an Orderly-key choice', async () => {
    await select('gemini');
    const response = await request(
      `/companies/${company.id}`,
      // Paused, so the live readiness checks for automatic replies do not apply.
      { ...company, botEnabled: false, ai: { ...company.ai, keyMode: 'platform' } },
      'PUT',
    );
    expect(response.status).toBe(200);
    expect((await repo.getCompany(company.id))?.ai).not.toHaveProperty('keyMode', 'platform');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps key tests owner-only and hides provider details when a key fails', async () => {
    await select('gemini');
    await saveOwn('gemini');
    vi.mocked(repo.getRole).mockResolvedValue('staff');
    expect((await request('/integrations/gemini/test', {})).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
    vi.mocked(repo.getRole).mockResolvedValue('owner');
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({ error: 'private upstream detail' }, { status: 403 }),
    );
    const failed = await request('/integrations/gemini/test', {});
    expect(failed.status).toBe(400);
    expect(await failed.text()).not.toContain('private upstream detail');
    expect((await repo.getIntegrations(company.id))[0].status).toBe('error');
  });
});
