import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../server/app';
import { MemoryRepository } from '../server/repository';
import { decryptSecret, encryptSecret } from '../server/security';
import { modelFingerprint } from '../server/integrations/model-catalog';
import { seedCompanies } from '../src/shared/seed';
import type { Company } from '../src/shared/types';

const { generate } = vi.hoisted(() => ({ generate: vi.fn() }));
// Keep the real error classes: the adapter uses them to decide what a failed call cost.
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: generate,
  Output: { object: vi.fn() },
}));

const company = seedCompanies[0]!;
const key = 'sk-ant-business-test-key-0001';
let repo: MemoryRepository;
let providerFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  repo = new MemoryRepository();
  vi.stubEnv('APP_MODE', 'demo');
  vi.stubEnv('ORDERLY_RUNTIME', '');
  vi.stubEnv('VERCEL', '');
  vi.stubEnv('APP_URL', 'http://127.0.0.1:5173');
  vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', Buffer.alloc(32, 9).toString('base64'));
  vi.stubEnv('MODEL_PRICING_JSON', '');
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  providerFetch = vi.fn(async () => new Response('{"data":[]}', { status: 200 }));
  vi.stubGlobal('fetch', providerFetch);
  generate.mockReset();
  generate.mockResolvedValue({
    output: {
      actions: [{ type: 'menu' }],
      response: { text: 'Here is our menu.', askFor: 'none' },
    },
    usage: { inputTokens: 900, outputTokens: 40 },
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const call = (path: string, body: unknown, method = 'POST') =>
  createApp(repo).request(`http://127.0.0.1:4000/api${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-company-id': company.id,
      Origin: 'http://127.0.0.1:5173',
    },
    body: JSON.stringify(body),
  });
const connect = (body: Record<string, unknown>) =>
  call('/ai/connect', {
    provider: 'anthropic',
    model: 'claude-haiku-5-5',
    approve: true,
    ...body,
  });
const stored = async () => (await repo.getCompany(company.id))!;

describe('POST /api/ai/connect', () => {
  it('checks the key, tests a reply, then saves the key and switches the model', async () => {
    const before = await stored();
    const response = await connect({ apiKey: key, monthlyBudgetUsd: 15 });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
    });
    const [url, init] = providerFetch.mock.calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/models');
    expect((init as RequestInit).headers).toMatchObject({ 'x-api-key': key });
    expect(generate).toHaveBeenCalledTimes(1);

    const after = await stored();
    expect(after.ai).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
      monthlyBudgetUsd: 15,
    });
    expect(after.privacy?.aiDataApproved).toBe(true);
    expect(after.botEnabled).toBe(before.botEnabled);
    expect(after.modelVerification?.fingerprint).toBe(modelFingerprint(after, key));
    expect(decryptSecret((await repo.getSecret(company.id, 'anthropic'))!)).toBe(key);
    const integration = (await repo.getIntegrations(company.id)).find(
      (item) => item.kind === 'anthropic',
    );
    expect(integration).toMatchObject({ configured: true, status: 'connected' });
    // The model step of the readiness checklist is now complete.
    const bootstrap = await (
      await createApp(repo).request('http://127.0.0.1:4000/api/bootstrap', {
        headers: { 'x-company-id': company.id, Origin: 'http://127.0.0.1:5173' },
      })
    ).json();
    expect(bootstrap.readiness.find((check: { id: string }) => check.id === 'model').ready).toBe(
      true,
    );
  });

  it('changes nothing when the provider rejects the key', async () => {
    providerFetch.mockResolvedValueOnce(new Response('{}', { status: 401 }));
    const before = await stored();
    const response = await connect({ apiKey: key });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/rejected this API key/);
    expect(generate).not.toHaveBeenCalled();
    expect(await stored()).toEqual(before);
    expect(await repo.getSecret(company.id, 'anthropic')).toBeUndefined();
  });

  it('changes nothing when the model cannot answer the test message', async () => {
    generate.mockRejectedValueOnce(new Error('model not found'));
    const before = await stored();
    const response = await connect({ apiKey: key, model: 'claude-haiku-5-5' });
    expect(response.status).toBe(422);
    expect((await response.json()).error).toMatch(
      /The key works, but Anthropic model “claude-haiku-5-5” could not answer a test message/,
    );
    const after = await stored();
    expect(after.ai).toEqual(before.ai);
    expect(after.modelVerification).toEqual(before.modelVerification);
    expect(await repo.getSecret(company.id, 'anthropic')).toBeUndefined();
  });

  it('requires the data agreement', async () => {
    const response = await call('/ai/connect', {
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
      apiKey: key,
      approve: false,
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/Tick the agreement/);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('reuses the key already saved for this business', async () => {
    const saved = 'sk-ant-previously-saved-key-02';
    await repo.saveIntegration(
      company.id,
      { kind: 'anthropic', configured: true, status: 'connected', config: {} },
      encryptSecret(saved),
    );
    const response = await connect({});
    expect(response.status).toBe(200);
    expect((providerFetch.mock.calls[0]![1] as RequestInit).headers).toMatchObject({
      'x-api-key': saved,
    });
    expect((await stored()).modelVerification?.fingerprint).toBe(
      modelFingerprint(await stored(), saved),
    );
  });

  it('asks for a key when none is saved or pasted, ignoring any server key', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-server-wide-key-0003');
    const response = await connect({});
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe(
      'Paste this restaurant’s Anthropic API key in Bot settings → AI model.',
    );
  });

  it('uses the pasted key when an older dashboard still asks for Orderly’s key', async () => {
    const response = await connect({ keyMode: 'platform', apiKey: key });
    expect(response.status).toBe(200);
    expect((providerFetch.mock.calls[0]![1] as RequestInit).headers).toMatchObject({
      'x-api-key': key,
    });
    expect(decryptSecret((await repo.getSecret(company.id, 'anthropic'))!)).toBe(key);
    expect((await stored()).ai).not.toHaveProperty('keyMode');
  });
});

describe('PUT /api/companies spending limit', () => {
  it('keeps a passed model test when only the monthly limit changes', async () => {
    expect((await connect({ apiKey: key })).status).toBe(200);
    const connected = await stored();
    const next: Company = { ...connected, ai: { ...connected.ai, monthlyBudgetUsd: 25 } };
    const response = await call(`/companies/${company.id}`, next, 'PUT');
    expect(response.status).toBe(200);
    const after = await stored();
    expect(after.ai.monthlyBudgetUsd).toBe(25);
    expect(after.modelVerification).toEqual(connected.modelVerification);
  });

  it('still clears the test when the model changes', async () => {
    expect((await connect({ apiKey: key })).status).toBe(200);
    const connected = await stored();
    const response = await call(
      `/companies/${company.id}`,
      { ...connected, botEnabled: false, ai: { ...connected.ai, model: 'claude-haiku-4-5' } },
      'PUT',
    );
    expect(response.status).toBe(200);
    expect((await stored()).modelVerification).toBeUndefined();
  });
});
