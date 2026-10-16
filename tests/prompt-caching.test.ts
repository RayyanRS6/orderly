import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRepository } from '../server/repository';
import { encryptSecret } from '../server/security';
import { AiModelAdapter } from '../server/integrations/models';
import { createConversation } from '../src/domain/engine';
import { defaultBot } from '../src/shared/bot';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import type { BotConfig, Company, ModelInterpretation, Provider } from '../src/shared/types';
import { systemText } from './helpers/model-call';

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
  knowledge: [{ question: 'کیا آپ کے پاس پارکنگ ہے؟', answer: 'جی ہاں، ریسٹورنٹ کے سامنے پارکنگ ہے۔' }],
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

  async function configure(provider: Provider, model: string, bot?: BotConfig): Promise<Company> {
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
});
