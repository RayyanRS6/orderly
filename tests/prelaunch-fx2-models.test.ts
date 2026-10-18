// Fix package 2 (ai-pipeline-8, tests-ci-8): a refused AI call is retried only with time left to
// answer, and a reply that cannot be used is never traced as validated.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APICallError } from 'ai';
import { MemoryRepository } from '../server/repository';
import { encryptSecret } from '../server/security';
import { AiModelAdapter, REFUSED_RETRY_MIN_MS } from '../server/integrations/models';
import { createConversation } from '../src/domain/engine';
import { defaultBot } from '../src/shared/bot';
import { MODEL_LIMITS } from '../src/shared/models';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import type { Company } from '../src/shared/types';

const { generate } = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: generate,
  Output: { object: vi.fn() },
}));

const company = seedCompanies[0]!;
const products = seedProducts.filter((p) => p.companyId === company.id);
const answered = {
  output: { actions: [{ type: 'menu' }], response: { text: 'Menu.', askFor: 'items' } },
  usage: { inputTokens: 1200, outputTokens: 80 },
};
// Overloaded, and the provider asks for no wait.
const busy = () =>
  new APICallError({
    message: 'overloaded',
    url: 'https://api.anthropic.com/v1/messages',
    requestBodyValues: {},
    statusCode: 529,
    responseBody: '{"type":"error"}',
    responseHeaders: { 'retry-after-ms': '1' },
  });
let repo: MemoryRepository;
let configured: Company;

beforeEach(async () => {
  generate.mockReset();
  repo = new MemoryRepository();
  vi.stubEnv('APP_MODE', 'demo');
  vi.stubEnv('ORDERLY_RUNTIME', '');
  vi.stubEnv('VERCEL', '');
  vi.stubEnv('MODEL_PRICING_JSON', '');
  vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  await repo.saveIntegration(
    company.id,
    { kind: 'anthropic', configured: true, status: 'connected', config: {} },
    encryptSecret('fictional-anthropic-key'),
  );
  configured = {
    ...company,
    ai: { provider: 'anthropic', model: 'claude-haiku-5-5', monthlyBudgetUsd: 10 },
    privacy: { aiDataApproved: true, retentionDays: 0 },
    bot: { draft: { ...defaultBot, language: 'en' }, revision: 1, history: [] },
  };
  await repo.saveCompany(configured);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
const interpret = () =>
  new AiModelAdapter(repo).interpret(
    configured,
    products,
    createConversation(company.id, '923000000998', 'demo', new Date().toISOString()),
    'what do you have?',
  );

describe('ai-pipeline-8c: a refused call is retried only with time left to answer', () => {
  it('keeps at least 10 s for the retry', () => {
    expect(REFUSED_RETRY_MIN_MS).toBe(10000);
    expect(MODEL_LIMITS.timeoutMs).toBeGreaterThan(REFUSED_RETRY_MIN_MS);
  });

  it('does not retry with less than that left, and bills the refusal at nothing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T10:00:00.000Z'));
    generate.mockImplementationOnce(async () => {
      // The refusal came back late: 9 s of the reply's deadline are left.
      vi.setSystemTime(Date.now() + MODEL_LIMITS.timeoutMs - 9000);
      throw busy();
    });
    generate.mockResolvedValue(answered);
    await expect(interpret()).rejects.toMatchObject({ reason: 'overloaded' });
    expect(generate).toHaveBeenCalledTimes(1);
    const [ledger] = await repo.listUsage(company.id);
    expect(ledger).toMatchObject({ costUsd: 0, rejected: true });
  });

  it('retries with more than that left', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T10:00:00.000Z'));
    generate.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + MODEL_LIMITS.timeoutMs - 12000);
      throw busy();
    });
    generate.mockResolvedValue(answered);
    await expect(interpret()).resolves.toMatchObject({ actions: [{ type: 'menu' }] });
    expect(generate).toHaveBeenCalledTimes(2);
  });
});

describe('ai-pipeline-8b: a reply that cannot be used is never traced as validated', () => {
  it('pays for the reply but writes no success trace', async () => {
    generate.mockResolvedValue({
      output: { actions: [] },
      usage: { inputTokens: 1200, outputTokens: 4000 },
    });
    await expect(interpret()).rejects.toMatchObject({ reason: 'bad_output' });
    expect((await repo.listTraces(company.id)).some((t) => t.action === 'model.completed')).toBe(
      false,
    );
    expect(await repo.listUsage(company.id)).toHaveLength(1);
  });

  it('still traces a valid reply', async () => {
    generate.mockResolvedValue(answered);
    await interpret();
    const trace = (await repo.listTraces(company.id)).find((t) => t.action === 'model.completed');
    expect(trace?.detail).toContain('Structured response validated.');
  });
});
