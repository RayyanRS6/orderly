import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../server/app';
import { MemoryRepository } from '../server/repository';
import { readiness } from '../server/readiness';
import { AI_TERMS_VERSION } from '../server/validation';
import { seedCompanies } from '../src/shared/seed';

const { generate } = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: generate,
  Output: { object: vi.fn() },
}));

const company = seedCompanies[0]!;
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
  providerFetch = vi.fn(async () => new Response('{"data":[],"models":[]}', { status: 200 }));
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
const connect = (body: Record<string, unknown>) =>
  createApp(repo).request('http://127.0.0.1:4000/api/ai/connect', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-company-id': company.id,
      Origin: 'http://127.0.0.1:5173',
    },
    body: JSON.stringify({
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
      apiKey: 'sk-ant-business-test-key-0001',
      approve: true,
      ...body,
    }),
  });
const stored = async () => (await repo.getCompany(company.id))!;
const privacyCheck = async () =>
  (await readiness(repo, await stored())).find((check) => check.id === 'privacy')!;

describe('AI data terms confirmations', () => {
  it('asks a dashboard from before the confirmations to reload, changing nothing', async () => {
    const before = await stored();
    const response = await connect({});
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('Please reload the page to continue.');
    expect(providerFetch).not.toHaveBeenCalled();
    expect(await stored()).toEqual(before);
  });

  it('requires the no-training confirmation, and the paid tier for Gemini', async () => {
    const noTraining = await connect({ attest: { noTrainingOptIn: false } });
    expect(noTraining.status).toBe(400);
    expect((await noTraining.json()).error).toContain('no data-sharing or training opt-in');
    const gemini = await connect({
      provider: 'gemini',
      model: 'gemini-2.5-flash-lite',
      apiKey: 'gemini-business-test-key-0001',
      attest: { noTrainingOptIn: true },
    });
    expect(gemini.status).toBe(400);
    expect((await gemini.json()).error).toContain('billing turned on (paid tier)');
    expect(providerFetch).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it('records who confirmed what, for which provider, with the terms version', async () => {
    const response = await connect({ attest: { noTrainingOptIn: true } });
    expect(response.status).toBe(200);
    expect((await stored()).privacy).toEqual({
      aiDataApproved: true,
      retentionDays: 0,
      aiApproval: {
        provider: 'anthropic',
        userId: 'local-demo-admin',
        at: expect.any(String),
        version: AI_TERMS_VERSION,
        noTrainingOptIn: true,
        paidTierAttested: false,
      },
    });
    expect(await privacyCheck()).toEqual({
      id: 'privacy',
      label: expect.any(String),
      ready: true,
    });
    const gemini = await connect({
      provider: 'gemini',
      model: 'gemini-2.5-flash-lite',
      apiKey: 'gemini-business-test-key-0001',
      attest: { noTrainingOptIn: true, paidTier: true },
    });
    expect(gemini.status).toBe(200);
    expect((await stored()).privacy?.aiApproval).toMatchObject({
      provider: 'gemini',
      paidTierAttested: true,
    });
    expect((await privacyCheck()).warning).toBeUndefined();
  });

  it('warns, without blocking live bots, when an older approval lacks the confirmations', async () => {
    await repo.saveCompany({
      ...company,
      ai: { provider: 'gemini', model: 'gemini-2.5-flash-lite', monthlyBudgetUsd: 10 },
      privacy: { aiDataApproved: true, retentionDays: 0 },
    });
    const check = await privacyCheck();
    expect(check.ready).toBe(true);
    expect(check.warning).toContain('paid (billed) Google Cloud project');
    await repo.saveCompany({
      ...(await stored()),
      ai: { provider: 'anthropic', model: 'claude-haiku-5-5', monthlyBudgetUsd: 10 },
      privacy: {
        aiDataApproved: true,
        retentionDays: 0,
        aiApproval: {
          provider: 'anthropic',
          userId: 'u',
          at: '2026-10-01T00:00:00.000Z',
          version: 'an-older-version',
          noTrainingOptIn: true,
          paidTierAttested: false,
        },
      },
    });
    expect(await privacyCheck()).toMatchObject({
      ready: true,
      warning: expect.stringContaining('no data-sharing or training opt-in'),
    });
    // No warning while AI is off, and none without any approval (the check is simply not ready).
    await repo.saveCompany({ ...company, privacy: { aiDataApproved: true, retentionDays: 0 } });
    expect((await privacyCheck()).warning).toBeUndefined();
  });

  it('drops the approval record when a replacement key is saved for the active provider', async () => {
    expect((await connect({ attest: { noTrainingOptIn: true } })).status).toBe(200);
    const response = await createApp(repo).request(
      'http://127.0.0.1:4000/api/integrations/anthropic',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-company-id': company.id,
          Origin: 'http://127.0.0.1:5173',
        },
        body: JSON.stringify({ config: {}, secret: 'sk-ant-another-account-key-02' }),
      },
    );
    expect(response.status).toBe(200);
    expect((await stored()).privacy).toEqual({ aiDataApproved: false, retentionDays: 0 });
  });
});
