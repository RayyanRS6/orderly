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
  for (const [, env] of providers) vi.stubEnv(env, '');
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

async function select(provider: Provider, keyMode: 'own' | 'platform') {
  company = {
    ...company,
    ai: { ...company.ai, provider, keyMode, model: modelDefaults[provider] },
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
    await select('gemini', 'platform');
    vi.stubEnv('MODEL_PRICING_JSON', '');
    expect(company.ai.model).toBe('gemini-3.5-flash-lite');
    expect(() => validateModelConfiguration(company)).not.toThrow();
  });
  it.each(providers)(
    'uses the selected %s platform key without changing the business key',
    async (kind, env, header, url) => {
      await select(kind, 'platform');
      const original = await saveOwn(kind);
      vi.stubEnv(env, 'platform-test-key');
      const bootstrap = await (await request('/bootstrap')).json();
      expect(bootstrap.aiConnection).toEqual({
        provider: kind,
        keyMode: 'platform',
        configured: true,
      });
      expect(JSON.stringify(bootstrap)).not.toContain('platform-test-key');
      expect(JSON.stringify(bootstrap)).not.toContain('business-test-key');
      vi.mocked(fetch).mockResolvedValueOnce(Response.json({ data: [] }));
      const response = await request(`/integrations/${kind}/test`, {});
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ keyMode: 'platform', status: 'connected' });
      expect(fetch).toHaveBeenCalledWith(
        url,
        expect.objectContaining({
          headers: expect.objectContaining({
            [header]: kind === 'openai' ? 'Bearer platform-test-key' : 'platform-test-key',
          }),
        }),
      );
      expect(await repo.getIntegrations(company.id)).toEqual([original]);
    },
  );

  it.each(providers)(
    'uses only the business %s key when own mode is selected',
    async (kind, env, header, url) => {
      await select(kind, 'own');
      await saveOwn(kind);
      vi.stubEnv(env, 'platform-test-key');
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

  it('can explicitly test a saved business key while the selected model uses the platform', async () => {
    await select('gemini', 'platform');
    await saveOwn('gemini');
    vi.stubEnv('GOOGLE_API_KEY', 'platform-test-key');
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ models: [] }));
    expect((await request('/integrations/gemini/test', { keyMode: 'own' })).status).toBe(200);
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: { 'x-goog-api-key': 'business-test-key' } }),
    );
  });

  it('reports a missing platform key without falling back to the saved business key', async () => {
    await select('gemini', 'platform');
    const original = await saveOwn('gemini');
    expect((await (await request('/bootstrap')).json()).aiConnection.configured).toBe(false);
    const response = await request('/integrations/gemini/test', {});
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain('platform gemini API key is not configured');
    expect(fetch).not.toHaveBeenCalled();
    expect(await repo.getIntegrations(company.id)).toEqual([original]);
  });

  it('reports a missing business key without falling back to an available platform key', async () => {
    await select('gemini', 'own');
    vi.stubEnv('GOOGLE_API_KEY', 'platform-test-key');
    expect((await (await request('/bootstrap')).json()).aiConnection.configured).toBe(false);
    expect((await request('/integrations/gemini/test', {})).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not let a company using business keys request a platform-key test', async () => {
    await select('gemini', 'own');
    vi.stubEnv('GOOGLE_API_KEY', 'platform-test-key');
    expect((await request('/integrations/gemini/test', { keyMode: 'platform' })).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not let a platform company test an unselected platform provider', async () => {
    await select('gemini', 'platform');
    vi.stubEnv('OPENAI_API_KEY', 'platform-test-key');
    expect((await request('/integrations/openai/test', { keyMode: 'platform' })).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves the admin-only switch from business keys to platform keys', async () => {
    await select('gemini', 'own');
    const response = await request(
      `/companies/${company.id}`,
      { ...company, ai: { ...company.ai, keyMode: 'platform' } },
      'PUT',
    );
    expect(response.status).toBe(403);
    expect((await repo.getCompany(company.id))?.ai.keyMode).toBe('own');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps platform tests owner-only and leaves business state unchanged on provider failure', async () => {
    await select('gemini', 'platform');
    const original = await saveOwn('gemini');
    vi.stubEnv('GOOGLE_API_KEY', 'platform-test-key');
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
    expect(await repo.getIntegrations(company.id)).toEqual([original]);
  });
});
