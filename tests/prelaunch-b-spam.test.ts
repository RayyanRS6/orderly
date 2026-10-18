import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MemoryRepository } from '../server/repository';
import { encryptSecret } from '../server/security';
import { handleTurn } from '../server/service';
import { companySchema } from '../server/validation';
import { modelFingerprint } from '../server/integrations/model-catalog';
import { createConversation, limitPaused } from '../src/domain/engine';
import { defaultBot } from '../src/shared/bot';
import { AI_LIMIT_DEFAULTS, AI_LIMIT_RANGES, effectiveAiLimits } from '../src/shared/models';
import { seedCompanies } from '../src/shared/seed';
import type { Company, Conversation, ModelInterpretation } from '../src/shared/types';

const { generate } = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: generate,
  Output: { object: vi.fn() },
}));

const company = seedCompanies[0]!;
const key = 'fictional-anthropic-key';
const menu: ModelInterpretation = {
  actions: [{ type: 'menu' }],
  response: { text: 'Here is our menu.', askFor: 'items' },
};
const BURST =
  'You’ve sent a lot of messages at once, so automatic replies are paused for 15 minutes. Our team can still see your messages.';
let repo: MemoryRepository;
let configured: Company;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-16T10:00:00.000Z'));
  generate.mockReset();
  generate.mockResolvedValue({ output: menu, usage: { inputTokens: 1200, outputTokens: 80 } });
  repo = new MemoryRepository();
  vi.stubEnv('APP_MODE', 'demo');
  vi.stubEnv('ORDERLY_RUNTIME', '');
  vi.stubEnv('VERCEL', '');
  vi.stubEnv('MODEL_PRICING_JSON', '');
  vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  await repo.saveIntegration(
    company.id,
    { kind: 'anthropic', configured: true, status: 'connected', config: {} },
    encryptSecret(key),
  );
  const base: Company = {
    ...company,
    botEnabled: true,
    ai: { provider: 'anthropic', model: 'claude-haiku-5-5', monthlyBudgetUsd: 10 },
    aiLimits: { repliesPerHour: 1000, repliesPerCustomerPerHour: 100 },
    privacy: { aiDataApproved: true, retentionDays: 0 },
    bot: { draft: { ...defaultBot, language: 'en' }, revision: 1, history: [] },
  };
  configured = {
    ...base,
    modelVerification: {
      fingerprint: modelFingerprint(base, key),
      checkedAt: new Date().toISOString(),
    },
  };
  await repo.saveCompany(configured);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

let phoneCounter = 0;
const newCustomer = () =>
  createConversation(
    company.id,
    `9230033${String(++phoneCounter).padStart(5, '0')}`,
    'whatsapp',
    '1970-01-01T00:00:00.000Z',
  );
async function message(conversation: Conversation, text = 'what do you have?') {
  const current = (await repo.getConversation(company.id, conversation.id)) ?? conversation;
  const result = await handleTurn(repo, configured, current, {
    messageId: randomUUID(),
    text,
    now: new Date().toISOString(),
  });
  return { result, saved: (await repo.getConversation(company.id, conversation.id))! };
}

describe('spam protection: one customer sending many messages at once', () => {
  it('pauses only that customer for 15 minutes at the 25th message in a minute, then answers again', async () => {
    const customer = newCustomer();
    for (let i = 0; i < 24; i++) expect((await message(customer)).saved.mode).toBe('bot');
    expect(generate).toHaveBeenCalledTimes(24);

    const paused = await message(customer);
    expect(paused.result.reply).toBe(BURST);
    expect(paused.saved.mode).toBe('human');
    expect(paused.saved.limitPause).toMatchObject({
      reason: 'burst',
      until: '2026-10-16T10:15:00.000Z',
    });
    expect(limitPaused(paused.saved)).toBe(true);
    expect(paused.result.explanation).toMatchObject({ notice: 'burst', outcome: 'staff' });
    expect(generate).toHaveBeenCalledTimes(24);

    // Others are answered as usual.
    expect((await message(newCustomer())).saved.mode).toBe('bot');

    // Later messages in the pause are saved for staff without a reply or a second notice.
    vi.setSystemTime(new Date('2026-10-16T10:05:00.000Z'));
    const quiet = await message(customer, 'hello??');
    expect(quiet.result.reply).toBe('');
    expect(quiet.saved.messages.at(-1)).toMatchObject({ role: 'customer', text: 'hello??' });

    // The pause ends by itself: no staff action is needed.
    vi.setSystemTime(new Date('2026-10-16T10:15:30.000Z'));
    const back = await message(customer);
    expect(back.saved.mode).toBe('bot');
    expect(back.result.reply).toContain('Here is our menu.');
  });

  it('tells the customer in their language whether their order is safe', async () => {
    await repo.saveCompany({
      ...configured,
      aiLimits: { ...configured.aiLimits!, messagesPerCustomerPerMinute: 5 },
    });
    configured = (await repo.getCompany(company.id))!;
    const customer = { ...newCustomer(), cart: { ...newCustomer().cart, orderId: 'order-1' } };
    await repo.saveConversation({ ...customer, version: 1 }, 0);
    for (let i = 0; i < 4; i++) await message(customer, 'mujhe menu chahiye');
    const paused = await message(customer, 'mujhe menu chahiye');
    expect(paused.result.reply).toBe(
      'Aap ne ek saath bohat se messages bheje hain, is liye automatic jawab 15 minute ke liye ruk gaye hain. Hamari team aap ke messages dekh sakti hai. Aap ke order par koi asar nahi para.',
    );
  });

  it('follows the restaurant’s own setting', async () => {
    await repo.saveCompany({
      ...configured,
      aiLimits: { ...configured.aiLimits!, messagesPerCustomerPerMinute: 5 },
    });
    configured = (await repo.getCompany(company.id))!;
    const customer = newCustomer();
    for (let i = 0; i < 4; i++) expect((await message(customer)).saved.mode).toBe('bot');
    expect((await message(customer)).saved.limitPause?.reason).toBe('burst');
  });

  it('counts only the last minute', async () => {
    const customer = newCustomer();
    for (let i = 0; i < 20; i++) await message(customer);
    vi.setSystemTime(new Date('2026-10-16T10:01:30.000Z'));
    for (let i = 0; i < 20; i++) expect((await message(customer)).saved.mode).toBe('bot');
  });
});

describe('the per-minute setting', () => {
  it('has a default and a range, and keeps the two existing defaults', () => {
    expect(AI_LIMIT_DEFAULTS.messagesPerCustomerPerMinute).toBe(25);
    expect(AI_LIMIT_RANGES.messagesPerCustomerPerMinute).toEqual([5, 120]);
    expect(effectiveAiLimits()).toEqual(AI_LIMIT_DEFAULTS);
    expect(
      effectiveAiLimits({ messagesPerCustomerPerMinute: 40 }).messagesPerCustomerPerMinute,
    ).toBe(40);
    for (const bad of [4, 121, 12.5, '40', null])
      expect(
        effectiveAiLimits({ messagesPerCustomerPerMinute: bad }).messagesPerCustomerPerMinute,
      ).toBe(25);
  });

  it('is optional when saving settings, so a dashboard from before it still saves', () => {
    const settings = (aiLimits: Record<string, unknown>) =>
      companySchema.safeParse({ ...company, aiLimits });
    expect(settings({ repliesPerHour: 300, repliesPerCustomerPerHour: 30 }).success).toBe(true);
    expect(
      settings({
        repliesPerHour: 300,
        repliesPerCustomerPerHour: 30,
        messagesPerCustomerPerMinute: 40,
      }).success,
    ).toBe(true);
    for (const bad of [4, 121, 12.5])
      expect(
        settings({
          repliesPerHour: 300,
          repliesPerCustomerPerHour: 30,
          messagesPerCustomerPerMinute: bad,
        }).success,
      ).toBe(false);
  });
});
