import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRepository } from '../server/repository';
import { encryptSecret } from '../server/security';
import { AiModelAdapter } from '../server/integrations/models';
import { createConversation } from '../src/domain/engine';
import { sellableCatalog } from '../src/shared/deals';
import { MODEL_LIMITS } from '../src/shared/models';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import type {
  Company,
  Conversation,
  Deal,
  DealChoiceGroup,
  ModelInterpretation,
  Product,
} from '../src/shared/types';
import { promptObject, systemText } from './helpers/model-call';

const { generate } = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: generate,
  Output: { object: vi.fn() },
}));

// What the AI is told about deals. A business without deals keeps the exact instructions and
// prompt it had (tests/prompt-caching.test.ts pins those against the captured snapshots).
const company = seedCompanies[0]!;
const products = seedProducts.filter((p) => p.companyId === company.id);
// Tuesday 20 October 2026, 13:00 in Karachi.
const NOW = '2026-10-20T08:00:00.000Z';
const answer: ModelInterpretation = {
  actions: [{ type: 'answer', text: '' }],
  response: { text: 'Here you go.', askFor: 'none' },
};
const drink: DealChoiceGroup = {
  id: 'g-drink',
  name: 'Drink',
  options: [
    { id: 'o-coke', name: 'Coke', price: 0 },
    { id: 'o-sprite', name: 'Sprite', price: 0 },
    { id: 'o-fanta', name: 'Fanta', price: 5000 },
  ],
};
const deal = (id: string, name: string, over: Partial<Deal> = {}): Deal => ({
  id,
  companyId: company.id,
  name,
  description: 'Biryani, raita and a drink.',
  emoji: '🎁',
  aliases: [],
  price: 79900,
  regularPrice: 99900,
  items: [
    { name: 'Chicken Biryani', quantity: 1 },
    { name: 'Drink', quantity: 1 },
  ],
  choices: [drink],
  available: true,
  position: 1,
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...over,
});
const deals = [
  deal('deal-1', 'Deal 1'),
  deal('lunch-deal', 'Lunch Deal', {
    position: 2,
    schedule: { days: [1, 2, 3, 4, 5], start: '15:00', end: '17:00', endDate: '2026-12-31' },
  }),
  deal('paused-deal', 'Family Deal', { position: 3, available: false }),
];
const catalog = (list: Deal[] = deals) =>
  sellableCatalog(company, products, list, NOW, { all: true });

describe('what the AI is told about deals', () => {
  let repo: MemoryRepository;
  let configured: Company;
  beforeEach(async () => {
    generate.mockReset();
    generate.mockResolvedValue({ output: answer, usage: { inputTokens: 2000, outputTokens: 300 } });
    vi.useFakeTimers({ now: new Date(NOW), toFake: ['Date'] });
    vi.stubEnv('APP_MODE', 'demo');
    vi.stubEnv('ORDERLY_RUNTIME', '');
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('MODEL_PRICING_JSON', '');
    vi.stubEnv('PROMPT_CACHE', '');
    vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
    repo = new MemoryRepository();
    configured = {
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
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function call(
    menu: Product[],
    options?: { hasDeals?: boolean },
    conversation: Conversation = createConversation(company.id, '923000000321', 'demo', NOW),
    text = 'what deals do you have?',
  ) {
    generate.mockClear();
    await new AiModelAdapter(repo).interpret(configured, menu, conversation, text, options);
    const request = generate.mock.calls[0]![0] as Record<string, unknown>;
    return {
      system: systemText(request.system),
      prompt: request.prompt as string,
      data: promptObject(request as { prompt?: string }),
    };
  }
  const RULE = 'Deals are menu items. Add a deal with add_item using its product id';

  it('adds the deals rule to the instructions only for a business with deals', async () => {
    const without = await call(products);
    const flagOff = await call(products, { hasDeals: false });
    expect(flagOff.system).toBe(without.system);
    expect(flagOff.prompt).toBe(without.prompt);
    expect(without.system).not.toContain(RULE);
    const withDeals = await call(catalog(), { hasDeals: true });
    expect(withDeals.system.split(RULE)).toHaveLength(2);
    expect(withDeals.system).toContain(
      'Never compute or state prices, savings, discounts, percentages or times yourself; you may repeat a deal’s `when` text exactly as given.',
    );
    // Nothing that changes with the time is in the instructions: the same at another hour.
    vi.setSystemTime(new Date('2026-10-20T11:00:00.000Z'));
    expect((await call(catalog(), { hasDeals: true })).system).toBe(withDeals.system);
    expect(
      withDeals.system.replace(
        ` ${withDeals.system.match(/Deals are menu items\.[^\n]*?offer staff\./)![0]}`,
        '',
      ),
    ).toBe(without.system);
  });

  it('lists deals in the catalog with what they include, their state and choices, never prices', async () => {
    const { data } = await call(catalog(), { hasDeals: true });
    const index = data.catalogIndex as Record<string, unknown>[];
    expect(index.find((entry) => entry.id === 'deal-1')).toEqual({
      id: 'deal-1',
      name: 'Deal 1',
      category: 'Deals',
      available: true,
      description: 'Biryani, raita and a drink.',
      aliases: [],
      variants: [],
      modifiers: [],
      deal: {
        includes: ['1 × Chicken Biryani', '1 × Drink'],
        choices: [
          {
            id: 'g-drink',
            name: 'Drink',
            options: [
              { id: 'o-coke', name: 'Coke' },
              { id: 'o-sprite', name: 'Sprite' },
              { id: 'o-fanta', name: 'Fanta' },
            ],
          },
        ],
        state: 'on',
      },
    });
    expect(index.find((entry) => entry.id === 'lunch-deal')!.deal).toMatchObject({
      state: 'later',
      when: 'Mon–Fri 15:00–17:00 · until 31 Dec',
      choices: [{ id: 'g-drink' }],
    });
    // A paused deal is there to be refused, without its choices.
    expect(index.find((entry) => entry.id === 'paused-deal')).toMatchObject({
      available: false,
      deal: { includes: ['1 × Chicken Biryani', '1 × Drink'], state: 'paused' },
    });
    expect(index.find((entry) => entry.id === 'paused-deal')!.deal).not.toHaveProperty('choices');
    // Dishes have no deal key.
    expect(index.find((entry) => entry.id === products[0]!.id)).not.toHaveProperty('deal');
    expect(JSON.stringify(index)).not.toContain('79900');
    expect(JSON.stringify(index)).not.toContain('schedule');
  });

  it('gives a deal in the cart without its stored times or regular price', async () => {
    const conversation = createConversation(company.id, '923000000321', 'demo', NOW);
    conversation.cart.items = [
      { productId: 'lunch-deal', quantity: 1, modifierIds: ['o-coke'], notes: '' },
    ];
    const { data } = await call(catalog(), { hasDeals: true }, conversation, 'hi');
    const lunch = (data.candidateCatalog as Product[]).find((p) => p.id === 'lunch-deal')!;
    expect(lunch.price).toBe(79900);
    expect(lunch.deal).toEqual({
      includes: ['1 × Chicken Biryani', '1 × Drink'],
      choices: [drink],
      state: 'later',
      when: 'Mon–Fri 15:00–17:00 · until 31 Dec',
    });
  });

  it('tells the AI which deal choice is open, only while one is', async () => {
    const conversation = createConversation(company.id, '923000000321', 'demo', NOW);
    expect(
      (await call(catalog(), { hasDeals: true }, conversation, 'sprite')).data,
    ).not.toHaveProperty('pendingDealChoice');
    conversation.pendingDealChoice = { productId: 'deal-1', quantity: 2, picked: [], notes: '' };
    const { data } = await call(catalog(), { hasDeals: true }, conversation, 'sprite');
    expect(data.pendingDealChoice).toEqual({
      productId: 'deal-1',
      groupName: 'Drink',
      options: [
        { id: 'o-coke', name: 'Coke' },
        { id: 'o-sprite', name: 'Sprite' },
        { id: 'o-fanta', name: 'Fanta' },
      ],
      picked: [],
    });
    expect((data.candidateCatalog as Product[]).map((p) => p.id)).toContain('deal-1');
  });

  it('leaves the catalog’s deal choices out when they would not fit the prompt', async () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      deal(`d${i}`, `Combo ${i + 1}`, {
        position: i,
        choices: Array.from({ length: 5 }, (_, g) => ({
          id: `d${i}-g${g}`,
          name: `Choice ${g + 1}`,
          options: Array.from({ length: 25 }, (_, o) => ({
            id: `d${i}-g${g}-option-number-${o}-with-a-long-id`,
            name: `Option ${o + 1} with a long descriptive name`,
            price: 0,
          })),
        })),
      }),
    );
    const { prompt, data } = await call(catalog(many), { hasDeals: true }, undefined, 'combo 1');
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(MODEL_LIMITS.maxPromptBytes);
    const index = data.catalogIndex as { deal?: Record<string, unknown> }[];
    expect(index.filter((entry) => entry.deal)).toHaveLength(50);
    expect(index.some((entry) => entry.deal && 'choices' in entry.deal)).toBe(false);
    // The deal the message names still carries its choices.
    const named = (data.candidateCatalog as Product[]).find((p) => p.id === 'd0')!;
    expect(named.deal!.choices).toHaveLength(5);
  });
});
