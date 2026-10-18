import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRepository } from '../server/repository';
import { encryptSecret } from '../server/security';
import { AiModelAdapter } from '../server/integrations/models';
import { createConversation } from '../src/domain/engine';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import type { Company, ModelInterpretation, PaymentMethod } from '../src/shared/types';
import { systemText } from './helpers/model-call';

const { generate } = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: generate,
  Output: { object: vi.fn() },
}));

// An owner who ticks a transfer and then unticks it saves paymentMethods: ['cash'] explicitly.
// That restaurant must send the AI exactly the words it sent before the setting existed, so
// its cached instructions keep working.
const company = seedCompanies[0]!;
const products = seedProducts.filter((p) => p.companyId === company.id);
const answer: ModelInterpretation = {
  actions: [{ type: 'answer', text: '' }],
  response: { text: 'We are open all day.', askFor: 'none', groundingIds: ['business:hours'] },
};

describe('payment methods and the words the AI reads', () => {
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

  async function call(paymentMethods?: PaymentMethod[]) {
    const configured: Company = {
      ...company,
      ...(paymentMethods && { paymentMethods }),
      ai: { provider: 'anthropic', model: 'claude-haiku-5-5', monthlyBudgetUsd: 10 },
      privacy: { aiDataApproved: true, retentionDays: 0 },
    };
    await repo.saveCompany(configured);
    await repo.saveIntegration(
      company.id,
      { kind: 'anthropic', configured: true, status: 'connected', config: {} },
      encryptSecret('fictional-anthropic-key'),
    );
    generate.mockClear();
    await new AiModelAdapter(repo).interpret(
      configured,
      products,
      createConversation(company.id, '923000000321', 'demo', new Date().toISOString()),
      'can I pay by JazzCash?',
    );
    const request = generate.mock.calls[0]![0] as Record<string, unknown>;
    return { system: systemText(request.system), prompt: request.prompt };
  }

  it('sends identical words whether cash only is saved explicitly, empty or never set', async () => {
    const unset = await call();
    expect(await call(['cash'])).toEqual(unset);
    expect(await call([])).toEqual(unset);
  });

  it('tells the AI about transfers only when the restaurant takes them', async () => {
    const unset = await call();
    const transfers = await call(['cash', 'jazzcash']);
    expect(transfers).not.toEqual(unset);
    expect(JSON.stringify(transfers)).toContain('jazzcash');
    expect(JSON.stringify(unset)).not.toContain('jazzcash');
  });
});
