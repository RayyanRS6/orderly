import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRepository } from '../server/repository';
import { AiModelAdapter, modelDefaults, modelRate } from '../server/integrations/models';
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
vi.mock('ai', () => ({ generateText: generate, Output: { object: vi.fn() } }));

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
    vi.stubEnv('ANTHROPIC_API_KEY', 'fictional-anthropic-key');
    vi.stubEnv('OPENAI_API_KEY', 'fictional-openai-key');
    vi.stubEnv('GOOGLE_API_KEY', 'fictional-google-key');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function configure(provider: Provider, model: string): Promise<Company> {
    const configured: Company = {
      ...company,
      ai: { provider, model, keyMode: 'platform', monthlyBudgetUsd: 10 },
      privacy: { aiDataApproved: true, retentionDays: 0 },
    };
    await repo.saveCompany(configured);
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
    ['gemini', 'gemini-3.5-flash-lite', [0.3, 2.5]],
    ['openai', 'gpt-5.4-mini', [0.75, 4.5]],
    ['anthropic', 'claude-haiku-4-5', [1, 5]],
  ] as const)(
    'sends no provider options to %s %s and caps output at 1,200 tokens',
    async (provider, model, [inputRate, outputRate]) => {
      const configured = await configure(provider, model);
      generate.mockResolvedValueOnce({
        output: answer,
        usage: { inputTokens: 1000, outputTokens: 100 },
      });
      const result = await interpret(configured);
      const call = generate.mock.calls[0]![0];
      expect('providerOptions' in call).toBe(false);
      expect(call.maxOutputTokens).toBe(1200);
      expect(result.usage!.costUsd).toBeCloseTo(
        (1000 * inputRate + 100 * outputRate) / 1_000_000,
        12,
      );
    },
  );
});
