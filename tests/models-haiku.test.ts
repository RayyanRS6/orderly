import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRepository } from '../server/repository';
import { encryptSecret } from '../server/security';
import { APICallError, NoObjectGeneratedError, type LanguageModelUsage } from 'ai';
import {
  AiLimitError,
  AiModelAdapter,
  failedCallCharge,
  modelDefaults,
  modelRate,
} from '../server/integrations/models';
import {
  generationProfile,
  KNOWN_MODEL_RATES,
  LONG_PROMPT_RATES,
  MODEL_DEFAULTS,
  MODEL_LIMITS,
  recommendedModel,
} from '../src/shared/models';
import { createConversation } from '../src/domain/engine';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import type { Company, ModelInterpretation, Provider } from '../src/shared/types';

const { generate } = vi.hoisted(() => ({ generate: vi.fn() }));
// Keep the real error classes: the adapter uses them to decide what a failed call cost.
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: generate,
  Output: { object: vi.fn() },
}));

const company = seedCompanies[0]!;
const products = seedProducts.filter((p) => p.companyId === company.id);
const answer: ModelInterpretation = {
  actions: [{ type: 'answer', text: '' }],
  response: { text: 'We are open all day.', askFor: 'none', groundingIds: ['business:hours'] },
};

describe('Claude Haiku 5.5 defaults, prices and generation profile', () => {
  beforeEach(() => {
    vi.stubEnv('MODEL_PRICING_JSON', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('makes Claude Haiku 5.5 the recommended Anthropic default', () => {
    expect(MODEL_DEFAULTS.anthropic).toBe('claude-haiku-5-5');
    expect(modelDefaults).toBe(MODEL_DEFAULTS);
    expect(recommendedModel('anthropic', 'claude-haiku-5-5')).toBe(true);
    expect(recommendedModel('anthropic', 'claude-haiku-4-5')).toBe(false);
    expect(KNOWN_MODEL_RATES['claude-haiku-5-5']).toEqual([0.1, 0.5]);
  });

  it('uses the standard rate up to 100,000 input tokens and the long-prompt rate above it', () => {
    expect(LONG_PROMPT_RATES['claude-haiku-5-5']).toEqual({
      aboveInputTokens: 100_000,
      rate: [0.5, 2.5],
    });
    expect(modelRate('claude-haiku-5-5')).toEqual([0.1, 0.5]);
    expect(modelRate('claude-haiku-5-5', undefined, 100_000)).toEqual([0.1, 0.5]);
    expect(modelRate('claude-haiku-5-5', undefined, 100_001)).toEqual([0.5, 2.5]);
    expect(modelRate('claude-haiku-5-5', undefined, 250_000)).toEqual([0.5, 2.5]);
  });

  it('lets custom and server pricing win over the long-prompt rate', () => {
    expect(modelRate('claude-haiku-5-5', [2, 3])).toEqual([2, 3]);
    expect(modelRate('claude-haiku-5-5', [2, 3], 250_000)).toEqual([2, 3]);
    vi.stubEnv('MODEL_PRICING_JSON', JSON.stringify({ 'claude-haiku-5-5': [0.2, 0.6] }));
    expect(modelRate('claude-haiku-5-5', undefined, 250_000)).toEqual([0.2, 0.6]);
  });

  it('applies a long-prompt rate only to models that have one', () => {
    expect(modelRate('gpt-5.4-mini', undefined, 500_000)).toEqual([0.75, 4.5]);
    expect(modelRate('gemini-3.5-flash-lite', undefined, 500_000)).toEqual([0.3, 2.5]);
    expect(modelRate('claude-haiku-4-5', undefined, 500_000)).toEqual([1, 5]);
  });

  it('refuses a model without known or custom prices', () => {
    expect(() => modelRate('claude-unpriced-model')).toThrow(/token prices/);
  });

  it.each(['claude-haiku-5-5', 'claude-sonnet-5', 'claude-opus-5-5'])(
    'lets the Claude 5-generation model %s think briefly within a 4,000-token cap',
    (model) => {
      expect(generationProfile('anthropic', model)).toMatchObject({
        maxOutputTokens: MODEL_LIMITS.thinkingMaxOutputTokens,
        effort: 'low',
        thinking: 'adaptive',
      });
      expect(MODEL_LIMITS.thinkingMaxOutputTokens).toBe(4000);
    },
  );

  it.each([
    ['openai', 'gpt-5.4-mini'],
    ['gemini', 'gemini-3.5-flash-lite'],
    ['gemini', 'gemini-2.5-flash'],
    ['anthropic', 'claude-haiku-4-5'],
    ['openai', 'claude-haiku-5-5'],
  ] as const)('answers directly with %s %s within 1,200 tokens', (provider, model) => {
    const profile = generationProfile(provider, model);
    expect(profile.maxOutputTokens).toBe(1200);
    expect(profile.thinking).toBe('none');
    expect(profile.effort).toBeUndefined();
    expect(profile.summary).toContain('1,200-token');
  });
});

describe('AiModelAdapter generation settings and usage', () => {
  let repo: MemoryRepository;
  beforeEach(() => {
    generate.mockReset();
    repo = new MemoryRepository();
    vi.stubEnv('APP_MODE', 'demo');
    vi.stubEnv('ORDERLY_RUNTIME', '');
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('MODEL_PRICING_JSON', '');
    vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function configure(provider: Provider, model: string): Promise<Company> {
    const configured: Company = {
      ...company,
      ai: { provider, model, monthlyBudgetUsd: 10 },
      privacy: { aiDataApproved: true, retentionDays: 0 },
    };
    await repo.saveCompany(configured);
    if (provider !== 'mock')
      await repo.saveIntegration(
        company.id,
        { kind: provider, configured: true, status: 'connected', config: {} },
        encryptSecret(`fictional-${provider}-key`),
      );
    return configured;
  }

  function interpret(configured: Company, text = 'what time do you open?') {
    return new AiModelAdapter(repo).interpret(
      configured,
      products,
      createConversation(company.id, '923000000321', 'demo', new Date().toISOString()),
      text,
    );
  }

  it('asks Claude Haiku 5.5 for low effort and a 4,000-token cap, and prices the usage', async () => {
    const configured = await configure('anthropic', 'claude-haiku-5-5');
    generate.mockResolvedValueOnce({
      output: answer,
      usage: { inputTokens: 2000, outputTokens: 300 },
    });
    const result = await interpret(configured);
    expect(generate).toHaveBeenCalledTimes(1);
    const call = generate.mock.calls[0]![0];
    expect(call.providerOptions).toEqual({ anthropic: { effort: 'low' } });
    expect(call.maxOutputTokens).toBe(4000);
    expect(call.maxRetries).toBe(0);
    expect(result.actions).toEqual(answer.actions);
    expect(result.response).toEqual(answer.response);
    expect(result.usage).toMatchObject({ inputTokens: 2000, outputTokens: 300, estimated: false });
    expect(result.usage!.costUsd).toBeCloseTo((2000 * 0.1 + 300 * 0.5) / 1_000_000, 12);
    expect(result.usage!.durationMs).toBeGreaterThanOrEqual(0);
    const [ledger] = await repo.listUsage(company.id);
    expect(ledger).toMatchObject({
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
      inputTokens: 2000,
      outputTokens: 300,
      estimated: false,
    });
    expect(ledger!.costUsd).toBeCloseTo(result.usage!.costUsd, 12);
  });

  it('sends the AI exactly the same prompt whether or not dishes have photos', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-16T10:00:00.000Z'));
    try {
      const configured = await configure('anthropic', 'claude-haiku-5-5');
      generate.mockResolvedValue({
        output: answer,
        usage: { inputTokens: 2000, outputTokens: 300 },
      });
      const conversation = createConversation(
        company.id,
        '923000000321',
        'demo',
        '2026-10-16T09:00:00.000Z',
      );
      const ask = (catalog: typeof products) =>
        new AiModelAdapter(repo).interpret(configured, catalog, conversation, '2 chicken biryani');
      await ask(products);
      const withPhotos = products.map((p) => ({
        ...p,
        imageUrl: `https://images.example/${p.id}.jpg`,
      }));
      await ask(withPhotos);
      const [plain, photos] = generate.mock.calls.map((call) => call[0]);
      expect(plain.prompt).toContain('"candidateCatalog":[{');
      expect(photos.prompt).toBe(plain.prompt);
      expect(photos.system).toEqual(plain.system);
      expect(photos.prompt).not.toContain('imageUrl');
      expect(photos.prompt).not.toContain('images.example');
    } finally {
      vi.useRealTimers();
    }
  });

  it('charges the long-prompt rate when Claude Haiku 5.5 reports more than 100,000 input tokens', async () => {
    const configured = await configure('anthropic', 'claude-haiku-5-5');
    generate.mockResolvedValueOnce({
      output: answer,
      usage: { inputTokens: 150_000, outputTokens: 1000 },
    });
    const result = await interpret(configured);
    expect(result.usage!.costUsd).toBeCloseTo((150_000 * 0.5 + 1000 * 2.5) / 1_000_000, 12);
  });

  it('keeps a conservative estimate when the provider omits token counts', async () => {
    const configured = await configure('anthropic', 'claude-haiku-5-5');
    generate.mockResolvedValueOnce({ output: answer, usage: {} });
    const result = await interpret(configured);
    expect(result.usage!.estimated).toBe(true);
    expect(result.usage!.outputTokens).toBe(4000);
    expect(result.usage!.inputTokens).toBeGreaterThan(16_000);
    expect(result.usage!.costUsd).toBeGreaterThan(0);
  });

  it.each([
    ['gemini', 'gemini-3.5-flash-lite', [0.3, 2.5], undefined],
    // OpenAI keeps no copy of the call, and its strict schema mode (which refuses optional
    // fields and oneOf) is off: the reply is checked against the schema in Orderly.
    ['openai', 'gpt-5.4-mini', [0.75, 4.5], { openai: { store: false, strictJsonSchema: false } }],
    ['anthropic', 'claude-haiku-4-5', [1, 5], undefined],
  ] as const)(
    'sends only the provider options %s %s needs and caps output at 1,200 tokens',
    async (provider, model, [inputRate, outputRate], options) => {
      const configured = await configure(provider, model);
      generate.mockResolvedValueOnce({
        output: answer,
        usage: { inputTokens: 1000, outputTokens: 100 },
      });
      const result = await interpret(configured);
      const call = generate.mock.calls[0]![0];
      if (options) expect(call.providerOptions).toEqual(options);
      else expect('providerOptions' in call).toBe(false);
      // Only Anthropic gets the instruction text wrapped with a cache marker.
      expect(typeof call.system).toBe(provider === 'anthropic' ? 'object' : 'string');
      expect(call.maxOutputTokens).toBe(1200);
      expect(result.usage!.costUsd).toBeCloseTo(
        (1000 * inputRate + 100 * outputRate) / 1_000_000,
        12,
      );
    },
  );

  const refused = (
    statusCode: number,
    responseBody: unknown = '{"type":"error"}',
    responseHeaders?: Record<string, string>,
  ) =>
    new APICallError({
      message: 'refused',
      url: 'https://api.anthropic.com/v1/messages',
      requestBodyValues: {},
      statusCode,
      responseBody: responseBody as string,
      responseHeaders,
    });
  const unusable = (
    inputTokens: number | undefined,
    outputTokens: number | undefined,
    cache: { cacheReadTokens?: number; cacheWriteTokens?: number } = {},
  ) =>
    new NoObjectGeneratedError({
      message: 'No object generated: response did not match schema.',
      text: '{}',
      response: { id: 'r1', timestamp: new Date(), modelId: 'claude-haiku-5-5' },
      usage: {
        inputTokens,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: cache.cacheReadTokens,
          cacheWriteTokens: cache.cacheWriteTokens,
        },
        outputTokens,
        outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
        totalTokens: undefined,
      } as LanguageModelUsage,
      finishReason: 'stop',
    });

  it.each([400, 401, 403, 404, 413, 422, 429, 503, 529])(
    'records no spending when the provider refuses the call with HTTP %i',
    async (status) => {
      const configured = await configure('anthropic', 'claude-haiku-5-5');
      // Busy and overloaded refusals are tried twice more first, as soon as allowed.
      generate.mockRejectedValue(refused(status, undefined, { 'retry-after-ms': '1' }));
      await expect(interpret(configured)).rejects.toMatchObject({ status: 503 });
      expect(generate).toHaveBeenCalledTimes([429, 503, 529].includes(status) ? 3 : 1);
      expect(await repo.listUsage(company.id)).toHaveLength(1);
      const [ledger] = await repo.listUsage(company.id);
      expect(ledger).toMatchObject({
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimated: false,
        rejected: true,
      });
      // The hold is settled, so the whole monthly budget is available again.
      expect(
        await repo.reserveAiCall(
          company.id,
          'next',
          10,
          new Date(Date.now() + 60_000).toISOString(),
        ),
      ).toEqual({ ok: true });
    },
  );

  it.each([
    ['a timeout', new DOMException('The operation was aborted due to timeout', 'TimeoutError')],
    ['a server error that may have generated text', refused(500)],
    ['a gateway timeout', refused(504)],
    ['an error reported inside a successful reply', refused(400, { object: 'response' })],
    ['a network failure', new TypeError('fetch failed')],
  ])('keeps the conservative charge after %s', async (_cause, error) => {
    const configured = await configure('anthropic', 'claude-haiku-5-5');
    generate.mockRejectedValueOnce(error);
    await expect(interpret(configured)).rejects.toMatchObject({ status: 503 });
    const [ledger] = await repo.listUsage(company.id);
    expect(ledger).toMatchObject({ estimated: true, outputTokens: 4000 });
    expect(ledger!.rejected).toBeUndefined();
    expect(ledger!.costUsd).toBeGreaterThan(0);
  });

  it('charges what the provider reported for a reply in the wrong shape', async () => {
    const configured = await configure('anthropic', 'claude-haiku-5-5');
    generate.mockRejectedValueOnce(unusable(1000, 50));
    await expect(interpret(configured)).rejects.toMatchObject({ status: 503 });
    const [ledger] = await repo.listUsage(company.id);
    expect(ledger).toMatchObject({ inputTokens: 1000, outputTokens: 50, estimated: false });
    expect(ledger!.costUsd).toBeCloseTo((1000 * 0.1 + 50 * 0.5) / 1_000_000, 12);
  });

  it('falls back to the estimate for any token count a wrong-shape reply leaves out', async () => {
    const configured = await configure('anthropic', 'claude-haiku-5-5');
    generate.mockRejectedValueOnce(unusable(1000, undefined));
    await expect(interpret(configured)).rejects.toMatchObject({ status: 503 });
    const [ledger] = await repo.listUsage(company.id);
    expect(ledger).toMatchObject({ inputTokens: 1000, outputTokens: 4000, estimated: true });
  });

  it('classifies failed calls by what the provider could have billed', () => {
    expect(failedCallCharge(refused(429))).toEqual({ kind: 'none' });
    expect(failedCallCharge(refused(429, undefined))).toEqual({ kind: 'none' });
    expect(failedCallCharge(refused(408))).toEqual({ kind: 'reserved' });
    expect(failedCallCharge(refused(502))).toEqual({ kind: 'reserved' });
    expect(failedCallCharge(new Error('unknown'))).toEqual({ kind: 'reserved' });
    expect(failedCallCharge(unusable(10, 20))).toEqual({
      kind: 'actual',
      inputTokens: 10,
      outputTokens: 20,
    });
    expect(failedCallCharge(unusable(10, 20, { cacheReadTokens: 5 }))).toEqual({
      kind: 'actual',
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 5,
    });
  });

  it('applies the spam limits only to live WhatsApp chats', async () => {
    const configured = await configure('anthropic', 'claude-haiku-5-5');
    const reserve = vi.spyOn(repo, 'reserveAiCall');
    generate.mockResolvedValue({ output: answer, usage: { inputTokens: 100, outputTokens: 10 } });
    await interpret(configured);
    expect(reserve.mock.calls[0]!.slice(4)).toEqual([undefined, undefined]);
    const live = {
      ...createConversation(company.id, '923000000322', 'whatsapp', new Date().toISOString()),
      botResumedAt: '2026-10-16T10:00:00.000Z',
      limitResumedAt: '2026-10-16T11:00:00.000Z',
    };
    await new AiModelAdapter(repo).interpret(configured, products, live, 'hi');
    expect(reserve.mock.calls[1]!.slice(4)).toEqual([live.id, '2026-10-16T11:00:00.000Z']);
  });

  it('names the limit that stopped a call', async () => {
    const configured = await configure('anthropic', 'claude-haiku-5-5');
    vi.spyOn(repo, 'reserveAiCall').mockResolvedValue({
      ok: false,
      limit: 'hourly',
      limitValue: 300,
      resetAt: '2026-10-16T12:00:00.000Z',
    });
    const error = await interpret(configured).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiLimitError);
    expect(error).toMatchObject({
      status: 429,
      limit: 'hourly',
      limitValue: 300,
      resetAt: '2026-10-16T12:00:00.000Z',
    });
    expect(generate).not.toHaveBeenCalled();
  });
});
