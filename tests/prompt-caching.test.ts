import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NoObjectGeneratedError, type LanguageModelUsage } from 'ai';
import { MemoryRepository } from '../server/repository';
import { encryptSecret } from '../server/security';
import { AiModelAdapter } from '../server/integrations/models';
import { createConversation } from '../src/domain/engine';
import { defaultBot } from '../src/shared/bot';
import { cacheMultipliers, KNOWN_CACHE_MULTIPLIERS, KNOWN_MODEL_RATES } from '../src/shared/models';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import type { BotConfig, Company, ModelInterpretation, Provider } from '../src/shared/types';
import { systemText } from './helpers/model-call';

type LiveProvider = Exclude<Provider, 'mock'>;
const { generate } = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: generate,
  Output: { object: vi.fn() },
}));

// The words the AI reads are pinned in files captured before prompt caching existed. These
// snapshots must never be regenerated with -u as part of a caching change.
const company = seedCompanies[0]!;
const products = seedProducts.filter((p) => p.companyId === company.id);
const answer: ModelInterpretation = {
  actions: [{ type: 'answer', text: '' }],
  response: { text: 'We are open all day.', askFor: 'none', groundingIds: ['business:hours'] },
};
const customBot: BotConfig = {
  ...defaultBot,
  name: 'Dastarkhwan helper',
  personality: 'professional',
  language: 'auto',
  goal: 'Help customers order quickly and answer menu questions.',
  instructions:
    'Customer se Roman Urdu mein baat karein agar woh Roman Urdu likhein. Pehle naam poochein, phir delivery ya pickup.',
  knowledge: [
    { question: 'کیا آپ کے پاس پارکنگ ہے؟', answer: 'جی ہاں، ریسٹورنٹ کے سامنے پارکنگ ہے۔' },
  ],
  greeting: 'Assalam o Alaikum! Dastarkhwan mein khush aamdeed.',
  handoffMessage: 'Hamari team abhi aap se baat karegi.',
  behaviorRules: [
    {
      id: 'rule-pause',
      enabled: true,
      when: 'The customer asks whether the kitchen is closed for prayer.',
      action: 'reply',
      response: 'Kitchen namaz ke waqt 15 minute ke liye band hota hai.',
      responseMode: 'exact',
    },
    {
      id: 'rule-manager',
      enabled: true,
      when: 'The customer asks for the manager.',
      action: 'handoff',
      response: '',
      responseMode: 'adaptive',
    },
  ],
};

describe('the instruction text and prompt the AI reads', () => {
  let repo: MemoryRepository;
  beforeEach(() => {
    generate.mockReset();
    generate.mockResolvedValue({ output: answer, usage: { inputTokens: 2000, outputTokens: 300 } });
    vi.useFakeTimers({ now: new Date('2026-10-16T09:00:00.000Z'), toFake: ['Date'] });
    repo = new MemoryRepository();
    vi.stubEnv('APP_MODE', 'demo');
    vi.stubEnv('ORDERLY_RUNTIME', '');
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('MODEL_PRICING_JSON', '');
    vi.stubEnv('PROMPT_CACHE', '');
    vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function configure(
    provider: LiveProvider,
    model: string,
    bot?: BotConfig,
  ): Promise<Company> {
    const configured: Company = {
      ...company,
      ai: { provider, model, monthlyBudgetUsd: 10 },
      privacy: { aiDataApproved: true, retentionDays: 0 },
      ...(bot && {
        bot: {
          draft: bot,
          published: {
            version: 3,
            config: bot,
            publishedAt: '2026-10-01T09:00:00.000Z',
            publishedBy: 'owner',
          },
          history: [],
          revision: 3,
        },
      }),
    };
    await repo.saveCompany(configured);
    await repo.saveIntegration(
      company.id,
      { kind: provider, configured: true, status: 'connected', config: {} },
      encryptSecret(`fictional-${provider}-key`),
    );
    return configured;
  }

  async function lastCall(configured: Company, text = 'what time do you open?') {
    generate.mockClear();
    await new AiModelAdapter(repo).interpret(
      configured,
      products,
      createConversation(company.id, '923000000321', 'demo', new Date().toISOString()),
      text,
    );
    return generate.mock.calls[0]![0] as Record<string, unknown>;
  }

  it('matches the instruction text and prompt captured before prompt caching', async () => {
    const call = await lastCall(await configure('anthropic', 'claude-haiku-5-5'));
    await expect(systemText(call.system)).toMatchFileSnapshot(
      './__snapshots__/system-prompt.default.txt',
    );
    await expect(call.prompt).toMatchFileSnapshot('./__snapshots__/user-prompt.default.txt');
  });

  it('matches the captured instruction text for a customised, multilingual bot', async () => {
    const call = await lastCall(await configure('anthropic', 'claude-haiku-5-5', customBot));
    await expect(systemText(call.system)).toMatchFileSnapshot(
      './__snapshots__/system-prompt.custom.txt',
    );
  });

  it.each([
    ['openai', 'gpt-5.4-mini'],
    ['gemini', 'gemini-3.5-flash-lite'],
  ] as const)('gives %s the same instruction text', async (provider, model) => {
    const call = await lastCall(await configure(provider, model));
    await expect(systemText(call.system)).toMatchFileSnapshot(
      './__snapshots__/system-prompt.default.txt',
    );
  });

  it('asks Anthropic to keep a copy of the unchanged instruction text, and nothing else', async () => {
    const anthropic = await lastCall(await configure('anthropic', 'claude-haiku-5-5'));
    expect(anthropic.system).toEqual({
      role: 'system',
      content: systemText(anthropic.system),
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    });
    expect(anthropic.providerOptions).toEqual({ anthropic: { effort: 'low' } });
    expect(typeof anthropic.prompt).toBe('string');
    for (const [provider, model] of [
      ['openai', 'gpt-5.4-mini'],
      ['gemini', 'gemini-3.5-flash-lite'],
    ] as const) {
      const call = await lastCall(await configure(provider, model));
      expect(typeof call.system).toBe('string');
      expect(call.system).toBe(systemText(anthropic.system));
    }
  });

  it('sends the plain instruction string when PROMPT_CACHE=off', async () => {
    vi.stubEnv('PROMPT_CACHE', ' OFF ');
    const call = await lastCall(await configure('anthropic', 'claude-haiku-5-5'));
    expect(typeof call.system).toBe('string');
  });
});

describe('pricing replies that reuse the prompt cache', () => {
  let repo: MemoryRepository;
  beforeEach(() => {
    generate.mockReset();
    repo = new MemoryRepository();
    vi.stubEnv('APP_MODE', 'demo');
    vi.stubEnv('ORDERLY_RUNTIME', '');
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('MODEL_PRICING_JSON', '');
    vi.stubEnv('PROMPT_CACHE', '');
    vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function priced(
    provider: LiveProvider,
    model: string,
    usage: Record<string, unknown>,
    pricing?: [number, number],
  ) {
    const configured: Company = {
      ...company,
      ai: { provider, model, monthlyBudgetUsd: 10, ...(pricing && { pricing }) },
      privacy: { aiDataApproved: true, retentionDays: 0 },
    };
    await repo.saveCompany(configured);
    await repo.saveIntegration(
      company.id,
      { kind: provider, configured: true, status: 'connected', config: {} },
      encryptSecret(`fictional-${provider}-key`),
    );
    generate.mockResolvedValueOnce({ output: answer, usage });
    const result = await new AiModelAdapter(repo).interpret(
      configured,
      products,
      createConversation(company.id, '923000000321', 'demo', new Date().toISOString()),
      'what time do you open?',
    );
    const ledger = (await repo.listUsage(company.id)).at(-1)!;
    return { result, ledger };
  }
  const details = (cacheReadTokens?: number, cacheWriteTokens?: number) => ({
    noCacheTokens: undefined,
    cacheReadTokens,
    cacheWriteTokens,
  });

  it('prices reused tokens at 0.1x and saved tokens at 1.25x on Claude Haiku 5.5', async () => {
    const { result, ledger } = await priced('anthropic', 'claude-haiku-5-5', {
      inputTokens: 10_000,
      outputTokens: 500,
      inputTokenDetails: details(2500, 500),
    });
    const expected = (7000 * 0.1 + 2500 * 0.01 + 500 * 0.125 + 500 * 0.5) / 1_000_000;
    expect(ledger.costUsd).toBeCloseTo(expected, 12);
    expect(ledger).toMatchObject({
      inputTokens: 10_000,
      cacheReadTokens: 2500,
      cacheWriteTokens: 500,
    });
    expect(result.usage).toMatchObject({ cacheReadTokens: 2500, cacheWriteTokens: 500 });
    expect(result.usage!.costUsd).toBeCloseTo(expected, 12);
  });

  it('uses the same multipliers on Claude Haiku 4.5', async () => {
    const { ledger } = await priced('anthropic', 'claude-haiku-4-5', {
      inputTokens: 10_000,
      outputTokens: 500,
      inputTokenDetails: details(6000, 0),
    });
    expect(ledger.costUsd).toBeCloseTo((4000 * 1 + 6000 * 0.1 + 500 * 5) / 1_000_000, 12);
  });

  it('counts reused tokens at full price for other Claude models and owner-typed prices', async () => {
    const unknown = await priced(
      'anthropic',
      'claude-sonnet-5',
      { inputTokens: 10_000, outputTokens: 500, inputTokenDetails: details(4000, 1000) },
      [2, 10],
    );
    expect(unknown.ledger.costUsd).toBeCloseTo(
      (5000 * 2 + 4000 * 2 + 1000 * 2.5 + 500 * 10) / 1_000_000,
      12,
    );
    const typed = await priced(
      'anthropic',
      'claude-haiku-5-5',
      { inputTokens: 10_000, outputTokens: 500, inputTokenDetails: details(4000, 0) },
      [0.1, 0.5],
    );
    expect(typed.ledger.costUsd).toBeCloseTo((10_000 * 0.1 + 500 * 0.5) / 1_000_000, 12);
  });

  it('keeps OpenAI pricing unchanged and records no cache fields for it', async () => {
    const { ledger, result } = await priced('openai', 'gpt-5.4-mini', {
      inputTokens: 10_000,
      outputTokens: 500,
      inputTokenDetails: details(8000, 0),
    });
    expect(ledger.costUsd).toBeCloseTo((10_000 * 0.75 + 500 * 4.5) / 1_000_000, 12);
    expect('cacheReadTokens' in ledger).toBe(false);
    expect('cacheReadTokens' in result.usage!).toBe(false);
  });

  it('records no cache fields when nothing was reused or saved', async () => {
    const { ledger } = await priced('anthropic', 'claude-haiku-5-5', {
      inputTokens: 2000,
      outputTokens: 300,
      inputTokenDetails: details(0, 0),
    });
    expect('cacheReadTokens' in ledger).toBe(false);
    expect('cacheWriteTokens' in ledger).toBe(false);
    expect(ledger.costUsd).toBeCloseTo((2000 * 0.1 + 300 * 0.5) / 1_000_000, 12);
  });

  it('applies the long-prompt rate, measured on all prompt tokens, with the multipliers', async () => {
    const { ledger } = await priced('anthropic', 'claude-haiku-5-5', {
      inputTokens: 150_000,
      outputTokens: 1000,
      inputTokenDetails: details(140_000, 0),
    });
    expect(ledger.costUsd).toBeCloseTo(
      (10_000 * 0.5 + 140_000 * 0.05 + 1000 * 2.5) / 1_000_000,
      12,
    );
  });

  it('still charges something for a reply whose whole prompt came from the cache', async () => {
    const { ledger } = await priced('anthropic', 'claude-haiku-5-5', {
      inputTokens: 5000,
      outputTokens: 50,
      inputTokenDetails: details(5000, 0),
    });
    expect(ledger.costUsd).toBeGreaterThan(0);
  });

  it('prices a billed reply in the wrong shape with its cache details', async () => {
    const configured: Company = {
      ...company,
      ai: { provider: 'anthropic', model: 'claude-haiku-5-5', monthlyBudgetUsd: 10 },
      privacy: { aiDataApproved: true, retentionDays: 0 },
    };
    await repo.saveCompany(configured);
    await repo.saveIntegration(
      company.id,
      { kind: 'anthropic', configured: true, status: 'connected', config: {} },
      encryptSecret('fictional-anthropic-key'),
    );
    generate.mockRejectedValueOnce(
      new NoObjectGeneratedError({
        message: 'No object generated: response did not match schema.',
        text: '{}',
        response: { id: 'r1', timestamp: new Date(), modelId: 'claude-haiku-5-5' },
        usage: {
          inputTokens: 3000,
          inputTokenDetails: details(2000, undefined),
          outputTokens: 40,
          outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
          totalTokens: undefined,
        } as LanguageModelUsage,
        finishReason: 'stop',
      }),
    );
    await expect(
      new AiModelAdapter(repo).interpret(
        configured,
        products,
        createConversation(company.id, '923000000321', 'demo', new Date().toISOString()),
        'hi',
      ),
    ).rejects.toMatchObject({ status: 503 });
    const [ledger] = await repo.listUsage(company.id);
    expect(ledger).toMatchObject({ inputTokens: 3000, cacheReadTokens: 2000, estimated: false });
    expect(ledger!.costUsd).toBeCloseTo((1000 * 0.1 + 2000 * 0.01 + 40 * 0.5) / 1_000_000, 12);
  });

  it('knows the cache prices of every Claude model it knows the base price of', () => {
    for (const model of Object.keys(KNOWN_MODEL_RATES).filter((m) => m.startsWith('claude-')))
      expect(KNOWN_CACHE_MULTIPLIERS[model]).toEqual({ read: 0.1, write: 1.25 });
    expect(cacheMultipliers('openai', 'gpt-5.4-mini')).toBeUndefined();
    expect(cacheMultipliers('anthropic', 'claude-new-model')).toEqual({ read: 1, write: 1.25 });
  });
});
