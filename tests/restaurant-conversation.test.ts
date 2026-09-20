import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app';
import { MemoryRepository } from '../server/repository';
import { modelFingerprint } from '../server/integrations/model-catalog';
import { defaultBot } from '../src/shared/bot';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import { createConversation, parseActions, processTurn } from '../src/domain/engine';
import { resolveItemMention, resolvePendingItemChoice } from '../src/domain/menu-resolver';
import type { ModelInterpretation, Product, TurnResult } from '../src/shared/types';

const { generate } = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('ai', () => ({ generateText: generate, Output: { object: vi.fn() } }));

const company = seedCompanies[0]!;
const products = seedProducts.filter((p) => p.companyId === company.id);
const biryani = products[0]!;
const karahi = products.find((p) => p.name.includes('Karahi'))!;
const now = '2026-09-09T13:30:00.000Z';
const fresh = () => createConversation(company.id, '923000000099', 'demo', now);
const output = (interpretation: ModelInterpretation) =>
  generate.mockResolvedValueOnce({
    output: interpretation,
    usage: { inputTokens: 100, outputTokens: 30 },
  });

describe('restaurant intent and response regressions', () => {
  it.each([
    'can you repeat my order for me?',
    'can you repeat my order first?',
    'mera order batao',
    'میرا آرڈر بتائیں',
  ])('answers a cart recap before asking for fulfillment: %s', (text) => {
    let c = fresh();
    const naan = products.find((p) => p.name.includes('Naan'))!;
    for (const [productId, quantity] of [
      [biryani.id, 1],
      [naan.id, 3],
    ] as const) {
      c = processTurn(company, products, c, {
        messageId: productId,
        text: 'add',
        now,
        action: { type: 'add_item', productId, quantity },
      }).conversation;
    }
    const before = structuredClone(c.cart);
    const result = processTurn(
      company,
      products,
      c,
      { messageId: text, text, now },
      [{ type: 'review' }],
      { text: 'Would you like pickup or delivery?', askFor: 'fulfillment' },
    );
    expect(result.reply).toContain('1 × Chicken Biryani');
    expect(result.reply).toContain('3 × Butter Naan');
    expect(result.reply).toContain('Rs. 750');
    expect(result.reply.indexOf('Chicken Biryani')).toBeLessThan(
      result.reply.indexOf('Would you like pickup'),
    );
    expect(result.conversation.cart).toEqual(before);
    expect(result.order).toBeUndefined();
    expect(result.traces).toContain('cart_summary');
  });

  it('shows an incomplete checkout cart before asking for missing details', () => {
    const c = fresh();
    c.cart.items = [{ productId: biryani.id, quantity: 2, modifierIds: [], notes: 'no onion' }];
    const result = processTurn(company, products, c, {
      messageId: 'checkout',
      text: 'review order',
      now,
      action: { type: 'review' },
    });
    expect(result.reply).toContain('2 × Chicken Biryani');
    expect(result.reply).toContain('no onion');
    expect(result.reply).toContain('pickup or delivery');
    expect(result.conversation.cart.status).toBe('building');
    expect(result.conversation.cart.reviewedRevision).toBeUndefined();
    expect(
      processTurn(company, products, result.conversation, {
        messageId: 'premature',
        text: 'confirm',
        now,
      }).order,
    ).toBeUndefined();
  });

  it('does not treat a complete-cart recap as consent or a confirmation review', () => {
    const c = fresh();
    c.cart.items = [{ productId: biryani.id, quantity: 1, modifierIds: [], notes: '' }];
    c.cart.fulfillment = 'pickup';
    c.cart.customerName = 'Ali';
    const result = processTurn(company, products, c, {
      messageId: 'recap',
      text: 'repeat my order',
      now,
    });
    expect(result.conversation.cart.status).toBe('building');
    expect(result.conversation.cart.reviewedRevision).toBeUndefined();
    expect(result.order).toBeUndefined();
    expect(result.reply).not.toContain('Reply “confirm”');
  });

  it('honors the configured next question even when checkout is incomplete', () => {
    const c = fresh();
    c.cart.items = [{ productId: biryani.id, quantity: 1, modifierIds: [], notes: '' }];
    const result = processTurn(
      company,
      products,
      c,
      { messageId: 'name-first-checkout', text: 'checkout please', now },
      [{ type: 'review' }],
      { text: 'What name should I put on your order?', askFor: 'name' },
    );
    expect(result.reply).toContain('1 × Chicken Biryani');
    expect(result.reply).toContain('What name should I put on your order?');
    expect(result.reply).not.toContain('pickup or delivery');
    expect(result.conversation.cart.status).toBe('building');
    expect(result.conversation.cart.reviewedRevision).toBeUndefined();
    expect(result.order).toBeUndefined();
  });

  it('retains unavailable selections in a recap without inventing a total', () => {
    const c = fresh();
    c.cart.items = [{ productId: biryani.id, quantity: 1, modifierIds: [], notes: '' }];
    const result = processTurn(company, [{ ...biryani, available: false }], c, {
      messageId: 'unavailable-recap',
      text: 'repeat my order',
      now,
    });
    expect(result.reply).toContain('Chicken Biryani · Unavailable');
    expect(result.reply).not.toContain('Rs.');
    expect(result.conversation.cart).toEqual(c.cart);
  });
  it.each([
    'biryani',
    'biriyani',
    'baryani',
    'biriyanii',
    'biryyani',
    'biryaanni',
    'briyani',
    'biriani',
  ])('recognizes chicken %s despite another chicken dish', (spelling) => {
    expect(
      resolveItemMention(products, company.id, `id like to order chicken ${spelling}`),
    ).toMatchObject({ kind: 'unique', product: { id: biryani.id } });
  });

  it('browses the chicken family without creating a pending order choice', () => {
    const result = processTurn(company, products, fresh(), {
      messageId: 'browse',
      text: 'what chicken on the menu?',
      now,
    });
    expect(result.reply).toContain(biryani.name);
    expect(result.reply).toContain(karahi.name);
    expect(result.conversation.cart.items).toEqual([]);
    expect(result.conversation.pendingItemChoice).toBeUndefined();
  });

  it('uses displayed choice order even when the catalog order differs', () => {
    expect(
      resolvePendingItemChoice(
        products,
        company.id,
        {
          candidateProductIds: [karahi.id, biryani.id],
          quantity: 2,
          requestedOptionNames: [],
          notes: '',
          originalText: '2 chicken',
        },
        '2',
      )?.id,
    ).toBe(biryani.id);
  });

  it('accepts a specific misspelled item after a previous broad clarification', () => {
    const c = fresh();
    c.pendingItemChoice = {
      candidateProductIds: [biryani.id, karahi.id],
      quantity: 2,
      requestedOptionNames: [],
      notes: 'no onion',
      originalText: '2 chicken no onion',
    };
    const result = processTurn(
      company,
      products,
      c,
      {
        messageId: 'choice',
        text: 'id like to order chicken biryyani',
        now,
      },
      [{ type: 'clarify_item', candidateProductIds: [biryani.id, karahi.id], quantity: 1 }],
      { text: 'Which chicken would you like?', askFor: 'none' },
    );
    expect(result.conversation.cart.items).toEqual([
      expect.objectContaining({ productId: biryani.id, quantity: 2, notes: 'no onion' }),
    ]);
    expect(result.conversation.pendingItemChoice).toBeUndefined();
    expect(result.reply).not.toContain('Which chicken');
    expect(result.reply).toContain('Rs. 900');
  });

  it.each(['staff', 'cancel', 'new order', 'menu'])(
    'does not trap %s inside a pending choice',
    (text) => {
      const c = fresh();
      c.pendingItemChoice = {
        candidateProductIds: [biryani.id, karahi.id],
        quantity: 2,
        requestedOptionNames: [],
        notes: '',
        originalText: '2 chicken',
      };
      const result = processTurn(company, products, c, { messageId: text, text, now });
      expect(result.traces).not.toContain('clarify_item');
      if (text === 'staff') expect(result.conversation.mode).toBe('human');
      if (text === 'cancel' || text === 'new order')
        expect(result.conversation.pendingItemChoice).toBeUndefined();
      if (text === 'menu') expect(result.conversation.pendingItemChoice?.quantity).toBe(2);
    },
  );

  it('does not add a misspelled item in a negated request', () => {
    expect(parseActions(company, products, fresh(), "don't add chicken biryyani")[0]?.type).toBe(
      'answer',
    );
  });

  it('keeps the bot active for a response-only answer', () => {
    const result = processTurn(
      company,
      products,
      fresh(),
      {
        messageId: 'question',
        text: 'hi id like to order',
        now,
      },
      [{ type: 'answer', text: '' }],
      {
        text: 'Welcome! Would you like the menu, or do you know what you want?',
        askFor: 'items',
      },
    );
    expect(result.reply).toBe('Welcome! Would you like the menu, or do you know what you want?');
    expect(result.conversation.mode).toBe('bot');
    expect(result.reply).not.toContain('Send “menu”');
  });

  it('renders the model menu introduction before the menu without a stock ordering prompt', () => {
    const result = processTurn(
      company,
      products,
      fresh(),
      {
        messageId: 'menu',
        text: 'show menu',
        now,
      },
      [{ type: 'menu' }],
      { text: 'Here is our menu:', askFor: 'none' },
    );
    expect(result.reply.startsWith('Here is our menu:')).toBe(true);
    expect(result.reply).not.toContain('Tell me the item and quantity');
  });

  it('accepts answer text with response metadata and harmless price wording', () => {
    const result = processTurn(
      company,
      products,
      fresh(),
      {
        messageId: 'answer-text',
        text: 'can we discuss pricing?',
        now,
      },
      [{ type: 'answer', text: 'Would you like to see the price of a particular dish?' }],
      {
        text: '',
        askFor: 'none',
        groundingIds: [biryani.id],
      },
    );
    expect(result.reply).toBe('Would you like to see the price of a particular dish?');
    expect(result.conversation.mode).toBe('bot');
  });

  it('allows a grounded hours answer while retaining an unfinished cart and item choice', () => {
    const c = fresh();
    c.cart.items = [{ productId: biryani.id, quantity: 1, modifierIds: [], notes: '' }];
    c.pendingItemChoice = {
      candidateProductIds: [biryani.id, karahi.id],
      quantity: 2,
      requestedOptionNames: [],
      notes: '',
      originalText: '2 chicken',
    };
    const result = processTurn(
      company,
      products,
      c,
      {
        messageId: 'hours',
        text: 'when do you open?',
        now,
      },
      [{ type: 'answer', text: '' }],
      {
        text: `Our opening time is ${company.openingHours.start}.`,
        askFor: 'none',
        groundingIds: ['business:hours'],
      },
    );
    expect(result.reply).toBe(`Our opening time is ${company.openingHours.start}.`);
    expect(result.conversation.mode).toBe('bot');
    expect(result.conversation.cart).toEqual(c.cart);
    expect(result.conversation.pendingItemChoice).toEqual(c.pendingItemChoice);
  });

  it('honors an explicitly revised quantity when resolving a choice', () => {
    const c = fresh();
    c.pendingItemChoice = {
      candidateProductIds: [biryani.id, karahi.id],
      quantity: 2,
      requestedOptionNames: [],
      notes: '',
      originalText: '2 chicken',
    };
    expect(parseActions(company, products, c, 'actually 3 chicken biryyani')[0]).toMatchObject({
      type: 'add_item',
      productId: biryani.id,
      quantity: 3,
    });
  });

  it('allows name-first instructions without inserting the default flow', () => {
    const result = processTurn(
      company,
      products,
      fresh(),
      {
        messageId: 'name-first',
        text: 'My name is Ali',
        now,
      },
      [{ type: 'set_details', customerName: 'Ali' }],
      {
        text: 'Thanks, Ali. Would you prefer pickup or delivery?',
        askFor: 'fulfillment',
      },
    );
    expect(result.reply).toBe('Thanks, Ali. Would you prefer pickup or delivery?');
    expect(result.conversation.cart.customerName).toBe('Ali');
  });

  it('does not allow a model response to mask an unavailable item or skip a missing variant', () => {
    for (const catalog of [[{ ...biryani, available: false }], [karahi]]) {
      const p = catalog[0]!;
      const result = processTurn(
        company,
        catalog,
        fresh(),
        {
          messageId: p.id,
          text: p.name,
          now,
        },
        [{ type: 'add_item', productId: p.id, quantity: 1 }],
        {
          text: 'Great choice! Pickup or delivery?',
          askFor: 'fulfillment',
        },
      );
      expect(result.conversation.cart.items).toEqual([]);
      expect(result.reply).not.toContain('Great choice');
      expect(result.traces).toContain('validation_failed:add_item');
    }
  });

  it('preserves genuine ambiguity instead of allowing a model to guess a flavor', () => {
    const lassis: Product[] = ['Lassi', 'Mango Lassi', 'Strawberry Lassi'].map((name, i) => ({
      ...biryani,
      id: `lassi-${i}`,
      name,
      aliases: [],
      variants: [],
      modifiers: [],
    }));
    const result = processTurn(
      company,
      lassis,
      fresh(),
      {
        messageId: 'lassi',
        text: 'id like 2 lassi',
        now,
      },
      [{ type: 'add_item', productId: lassis[0]!.id, quantity: 2 }],
      {
        text: 'Pickup or delivery?',
        askFor: 'fulfillment',
      },
    );
    expect(result.conversation.cart.items).toEqual([]);
    expect(result.conversation.pendingItemChoice?.quantity).toBe(2);
    expect(result.conversation.pendingItemChoice?.candidateProductIds).toHaveLength(3);
    expect(result.reply).not.toContain('Pickup or delivery?');
  });

  it('does not create a choice for two explicitly named dishes', () => {
    const actions = parseActions(
      company,
      products,
      fresh(),
      '1 chicken biryani and 1 half chicken karahi',
    );
    expect(actions.map((action) => action.type)).toEqual(['add_item', 'add_item']);
  });

  it('keeps every successful addition visible when collecting details in the same turn', () => {
    const result = processTurn(
      company,
      products,
      fresh(),
      {
        messageId: 'batch',
        text: 'biryani with raita and plain biryani, pickup, Ali',
        now,
      },
      [
        {
          type: 'add_item',
          productId: biryani.id,
          quantity: 1,
          modifierIds: [biryani.modifiers[0]!.id],
        },
        { type: 'add_item', productId: biryani.id, quantity: 1 },
        { type: 'set_details', customerName: 'Ali', fulfillment: 'pickup' },
      ],
      { text: 'Would you like anything else?', askFor: 'anything_else' },
    );
    expect(result.reply).toContain('Rs. 530');
    expect(result.reply).toContain('Rs. 450');
    expect(result.reply).toContain('Rs. 980');
    expect(result.reply).not.toContain('Send “menu”');
  });
});

describe('configured model pipeline', () => {
  let repo: MemoryRepository;
  beforeEach(async () => {
    generate.mockReset();
    repo = new MemoryRepository();
    vi.stubEnv('APP_MODE', 'demo');
    vi.stubEnv('ORDERLY_RUNTIME', '');
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('GOOGLE_API_KEY', 'fictional-test-key');
    const configured = {
      ...company,
      botEnabled: true,
      ai: {
        ...company.ai,
        provider: 'gemini' as const,
        model: 'gemini-3.5-flash-lite',
        keyMode: 'platform' as const,
      },
      privacy: { aiDataApproved: true, retentionDays: 0 },
      bot: {
        draft: {
          ...defaultBot,
          goal: 'Help guests order accurately.',
          instructions: 'Ask for a name first. Answer interruptions and keep the cart.',
          knowledge: [{ question: 'Parking', answer: 'Free parking behind the restaurant.' }],
        },
        revision: 1,
        history: [],
      },
    };
    await repo.saveCompany({
      ...configured,
      modelVerification: {
        fingerprint: modelFingerprint(configured, 'fictional-test-key'),
        checkedAt: now,
      },
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function chat(text: string, interpretation: ModelInterpretation, conversationId?: string) {
    output(interpretation);
    const response = await createApp(repo).request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'x-company-id': company.id, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId: randomUUID(), text, conversationId, testTarget: 'draft' }),
    });
    const result = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(200);
    return result as TurnResult;
  }

  it('replays the reported conversation through Gemini interpretation on every message', async () => {
    let result = await chat('hi id like to order', {
      actions: [{ type: 'answer', text: '' }],
      response: { text: 'Welcome! What is your name?', askFor: 'name' },
    });
    expect(result.reply).toBe('Welcome! What is your name?');
    result = await chat(
      'what chicken on the menu?',
      {
        actions: [{ type: 'menu', query: 'chicken' }],
        response: { text: 'Our chicken dishes:', askFor: 'none' },
      },
      result.conversation.id,
    );
    expect(result.conversation.pendingItemChoice).toBeUndefined();
    result = await chat(
      'id like to order chicken biryyani',
      {
        actions: [{ type: 'add_item', productId: biryani.id, quantity: 1 }],
        response: { text: 'What name should I use?', askFor: 'name' },
      },
      result.conversation.id,
    );
    expect(result.conversation.cart.items[0]?.productId).toBe(biryani.id);
    expect(result.conversation.mode).toBe('bot');
    expect(result.reply).toContain('What name should I use?');
    expect(generate).toHaveBeenCalledTimes(3);
    expect(await repo.listCompanyJobs(company.id)).toEqual([]);
    const call = generate.mock.calls[2]![0];
    expect(call.system).toContain('Ask for a name first. Answer interruptions and keep the cart.');
    const prompt = JSON.parse(call.prompt);
    expect(prompt.business.openingHours).toEqual(company.openingHours);
    expect(prompt.business.faqs).toContainEqual({
      question: 'Parking',
      answer: 'Free parking behind the restaurant.',
    });
    expect(prompt.history).toHaveLength(4);
    expect(prompt.deterministicResolution).toMatchObject({ kind: 'unique', productId: biryani.id });
    expect(prompt.catalogIndex.every((p: { id?: string }) => p.id)).toBe(true);
  });

  it('persists the cart without Sheets and restores it through the tenant-scoped read API', async () => {
    const result = await chat('one biryani', {
      actions: [{ type: 'add_item', productId: biryani.id, quantity: 1 }],
      response: { text: 'Would you like anything else?', askFor: 'anything_else' },
    });
    const app = createApp(repo);
    const restored = await app.request(
      `http://localhost/api/conversations/${result.conversation.id}`,
      {
        headers: { 'x-company-id': company.id },
      },
    );
    expect(restored.status).toBe(200);
    expect((await restored.json()).cart).toEqual(result.conversation.cart);
    const recap = await chat(
      'can you repeat my order first?',
      {
        actions: [{ type: 'answer', text: '' }],
        response: { text: 'Would you like pickup or delivery?', askFor: 'fulfillment' },
      },
      result.conversation.id,
    );
    expect(recap.reply).toContain('1 × Chicken Biryani');
    expect(await repo.listCompanyJobs(company.id)).toEqual([]);
    const other = await app.request(
      `http://localhost/api/conversations/${result.conversation.id}`,
      {
        headers: { 'x-company-id': seedCompanies[1]!.id },
      },
    );
    expect(other.status).toBe(404);
  });

  it('evaluates owner rules and answers interruptions even while an item choice is pending', async () => {
    const saved = (await repo.getCompany(company.id))!;
    saved.bot!.draft.behaviorRules = [
      {
        id: 'pause',
        enabled: true,
        when: 'Customer asks to wait',
        action: 'reply',
        responseMode: 'exact',
        response: 'Take your time; your order is saved.',
      },
    ];
    expect(await repo.saveBot(company.id, saved.bot!, saved.bot!.revision)).toBe(true);
    let result = await chat('2 chicken', {
      actions: [
        { type: 'clarify_item', candidateProductIds: [biryani.id, karahi.id], quantity: 2 },
      ],
      response: { text: '', askFor: 'none' },
    });
    result = await chat(
      'please wait',
      {
        actions: [{ type: 'answer', text: '' }],
        response: { text: '', askFor: 'none', matchedRuleId: 'pause', groundingIds: ['pause'] },
      },
      result.conversation.id,
    );
    expect(result.reply).toBe('Take your time; your order is saved.');
    expect(result.conversation.mode).toBe('bot');
    expect(result.conversation.pendingItemChoice?.quantity).toBe(2);
    expect(result.traces).toContain('behavior_rule:pause');
    result = await chat(
      'chicken biryyani',
      {
        actions: [{ type: 'add_item', productId: biryani.id, quantity: 1 }],
        response: { text: 'What name should I use?', askFor: 'name' },
      },
      result.conversation.id,
    );
    expect(result.conversation.cart.items[0]?.quantity).toBe(2);
    expect(generate).toHaveBeenCalledTimes(3);
  });

  it('supplies products beyond the old 200-item cutoff with descriptions and option IDs', async () => {
    for (let i = 0; i < 205; i++)
      await repo.saveProduct({
        ...biryani,
        id: randomUUID(),
        name: `Dish ${i}`,
        aliases: [],
        description: 'Grilled with herbs.',
      });
    await chat('What grilled dishes do you have?', {
      actions: [{ type: 'answer', text: '' }],
      response: { text: 'Our menu includes herb-grilled dishes.', askFor: 'none' },
    });
    const prompt = JSON.parse(generate.mock.calls[0]![0].prompt);
    expect(prompt.catalogIndex).toHaveLength(products.length + 205);
    expect(prompt.catalogIndex.find((p: { name: string }) => p.name === 'Dish 204')).toMatchObject({
      description: 'Grilled with herbs.',
      modifiers: expect.arrayContaining([
        { id: biryani.modifiers[0]!.id, name: biryani.modifiers[0]!.name },
      ]),
    });
  });
});
