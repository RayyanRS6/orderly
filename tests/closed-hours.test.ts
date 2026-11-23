// A restaurant that is closed takes no order. Written after 21 Nov 2026, 04:57 am: with 15:00–03:00
// saved, the bot said once that it was closed, then added dishes, took a delivery address and a
// name, and handed the chat to staff "shortly". No order existed, and the customer waited for it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MemoryRepository } from '../server/repository';
import { encryptSecret } from '../server/security';
import { handleTurn } from '../server/service';
import { modelFingerprint } from '../server/integrations/model-catalog';
import { closedRefusal, createConversation, emptyCart, processTurn } from '../src/domain/engine';
import { defaultBot } from '../src/shared/bot';
import { sellableCatalog } from '../src/shared/deals';
import { describeCorrection, describeStep } from '../src/shared/explain';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import type {
  BotAction,
  BotConfig,
  Company,
  Conversation,
  Deal,
  Language,
  ModelInterpretation,
  ModelResponse,
  TurnInput,
} from '../src/shared/types';

const { generate } = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: generate,
  Output: { object: vi.fn() },
}));

// Karachi time, 21 November 2026 (no daylight saving).
const pkt = (time: string, day = '21') => new Date(`2026-11-${day}T${time}:00+05:00`).toISOString();
const base = seedCompanies[0]!;
const products = seedProducts.filter((p) => p.companyId === base.id);
const biryani = products.find((p) => p.name === 'Chicken Biryani')!;
// Dishes that can be added as they are.
const others = products.filter((p) => p.id !== biryani.id && p.available && !p.variants.length);
const OWNER_HANDOFF =
  'I’ve passed your chat to our team, and someone will reply right here shortly. Your cart is saved.';
const restaurant = (config: Partial<BotConfig> = {}, change: Partial<Company> = {}): Company => {
  const bot = { ...defaultBot, ...config };
  return {
    ...base,
    openingHours: { start: '15:00', end: '03:00', days: [0, 1, 2, 3, 4, 5, 6] },
    deliveryZones: [{ name: 'Islamabad & Rawalpindi', fee: 0 }],
    bot: {
      draft: bot,
      revision: 1,
      history: [],
      published: {
        version: 1,
        config: bot,
        publishedAt: '2026-10-22T10:00:00.000Z',
        publishedBy: 'owner',
      },
    },
    ...change,
  };
};
const CLOSED =
  'We are currently closed. Ordering hours are 15:00–03:00. We open again today at 15:00.';
const NOT_ORDERED =
  'We can’t take orders now, so this has not been ordered. Please message us again when we are open.';
const CART_SAVED =
  'Your cart is saved, but nothing in it has been ordered. Send “review” when we are open.';
const TEAM = 'Our team will reply here once we are open.';

let message = 0;
function turn(
  company: Company,
  c: Conversation,
  text: string,
  at: string,
  actions?: BotAction[],
  response?: ModelResponse,
  extra: Partial<TurnInput> = {},
  catalog = products,
) {
  return processTurn(
    company,
    catalog,
    c,
    { messageId: `closed-${++message}`, text, now: at, ...extra },
    actions,
    response,
  );
}
let customer = 0;
const fresh = (language: Language = 'en'): Conversation => ({
  ...createConversation(
    base.id,
    `9230000${String(++customer).padStart(5, '0')}`,
    'whatsapp',
    pkt('01:00'),
  ),
  language,
});
// A cart ready to confirm, built at 02:50 while open.
function reviewedOpen(company: Company) {
  let c = turn(company, fresh(), 'order', pkt('02:50'), undefined, undefined, {
    action: { type: 'add_item', productId: biryani.id, quantity: 2 },
  }).conversation;
  c = turn(company, c, 'details', pkt('02:51'), undefined, undefined, {
    action: { type: 'set_details', fulfillment: 'pickup', customerName: 'Ali' },
  }).conversation;
  c = turn(company, c, 'review', pkt('02:52')).conversation;
  expect(c.cart.status).toBe('awaiting_confirmation');
  return c;
}

describe('the 21 November chat, replayed', () => {
  it('takes nothing, says so each time, and tells the customer when the team replies', () => {
    const company = restaurant({ greeting: 'Welcome! 🌙', handoffMessage: OWNER_HANDOFF });
    let c = fresh();
    const say = (
      text: string,
      at: string,
      actions: BotAction[],
      response: ModelResponse,
    ): string => {
      const result = turn(company, c, text, pkt(at), actions, response);
      c = result.conversation;
      expect(result.order).toBeUndefined();
      expect(c.cart.items).toHaveLength(0);
      expect(c.cart.customerName).toBeUndefined();
      expect(c.cart.address).toBeUndefined();
      return result.reply;
    };
    expect(
      say('Hi', '04:57', [{ type: 'answer', text: '' }], {
        text: 'What are you craving?',
        askFor: 'items',
      }),
    ).toBe(`Welcome! 🌙\n\n${CLOSED} You can look at the menu now and order when we open.`);
    const refused = `${CLOSED} ${NOT_ORDERED}`;
    expect(
      say(
        'Bhi ik pasta small',
        '04:57',
        [
          {
            type: 'clarify_item',
            candidateProductIds: others.map((p) => p.id),
            quantity: 1,
          },
        ],
        { text: 'Small size noted.', askFor: 'none' },
      ),
    ).toBe(refused);
    expect(
      say('2', '04:58', [{ type: 'add_item', productId: biryani.id, quantity: 1 }], {
        text: 'All set. Anything else for you?',
        askFor: 'anything_else',
      }),
    ).toBe(refused);
    expect(
      say('Delivery', '05:04', [{ type: 'set_details', fulfillment: 'delivery' }], {
        text: 'Delivery noted. Which name should I put on the order?',
        askFor: 'name',
      }),
    ).toBe(refused);
    expect(
      say(
        'Islamabad',
        '05:06',
        [{ type: 'set_details', zone: 'Islamabad & Rawalpindi', address: 'Bilal Masjid ke paas' }],
        { text: 'Location aur address note kar liye.', askFor: 'name' },
      ),
    ).toBe(refused);
    expect(
      say(
        'Danish Khan',
        '05:08',
        [{ type: 'set_details', customerName: 'Danish Khan' }, { type: 'review' }],
        { text: 'Thanks!', askFor: 'none' },
      ),
    ).toBe(refused);
    expect(
      say('Payment account mein easypaisa', '05:09', [{ type: 'handoff' }], {
        text: '',
        askFor: 'none',
      }),
    ).toBe(`I’ve passed your chat to our team. ${CLOSED} ${TEAM}`);
    expect(c.mode).toBe('human');
  });
});

describe('every step of an order while closed', () => {
  const steps: [string, BotAction][] = [
    ['add_item', { type: 'add_item', productId: biryani.id, quantity: 1 }],
    [
      'clarify_item',
      { type: 'clarify_item', candidateProductIds: others.map((p) => p.id), quantity: 1 },
    ],
    ['set_details', { type: 'set_details', fulfillment: 'pickup', customerName: 'Ali' }],
    ['review', { type: 'review' }],
    ['confirm', { type: 'confirm' }],
    ['new_order', { type: 'new_order' }],
  ];
  it.each(steps)(
    'refuses %s from the AI, from a button and on local rules alike',
    (type, action) => {
      const company = restaurant();
      const runs = [
        turn(company, fresh(), 'please', pkt('04:00'), [action], {
          text: 'Noted, all set!',
          askFor: 'none',
        }),
        turn(company, fresh(), 'please', pkt('04:00'), undefined, undefined, { action }),
        turn(company, fresh(), 'please', pkt('04:00'), [action]),
      ];
      for (const result of runs) {
        expect(result.reply).toBe(`${CLOSED} ${NOT_ORDERED}`);
        expect(result.order).toBeUndefined();
        expect(result.conversation.mode).toBe('bot');
        expect(result.conversation.cart).toEqual(emptyCart());
        expect(result.conversation.pendingItemChoice).toBeUndefined();
        expect(result.traces).toEqual(['closed_refused']);
        expect(result.traces).not.toContain(type);
      }
    },
  );

  it('takes the same order a minute before closing and from opening', () => {
    const company = restaurant();
    const add: BotAction = { type: 'add_item', productId: biryani.id, quantity: 1 };
    for (const [at, items] of [
      ['02:59', 1],
      ['03:00', 0],
      ['14:59', 0],
      ['15:00', 1],
    ] as const)
      expect(
        turn(company, fresh(), 'order', pkt(at), [add]).conversation.cart.items,
        at,
      ).toHaveLength(items);
  });

  it('reads a message typed on local rules the same way', () => {
    const result = turn(restaurant(), fresh(), '2 chicken biryani', pkt('04:00'));
    expect(result.reply).toBe(`${CLOSED} ${NOT_ORDERED}`);
    expect(result.conversation.cart.items).toHaveLength(0);
  });

  it('adds no deal and asks none of its choices', () => {
    const deal: Deal = {
      id: 'deal-1',
      companyId: base.id,
      name: 'Deal 1',
      description: '',
      emoji: '🎁',
      aliases: [],
      price: 79900,
      items: [{ name: 'Zinger burger', quantity: 1 }],
      choices: [{ id: 'g', name: 'Drink', options: [{ id: 'coke', name: 'Coke', price: 0 }] }],
      available: true,
      position: 1,
      updatedAt: '2026-10-01T00:00:00.000Z',
    };
    const company = restaurant();
    const catalog = sellableCatalog(company, products, [deal], pkt('04:00'), { all: true });
    const result = turn(
      company,
      fresh(),
      'deal 1',
      pkt('04:00'),
      [{ type: 'add_item', productId: deal.id, quantity: 1 }],
      { text: 'Which drink?', askFor: 'none' },
      {},
      catalog,
    );
    expect(result.reply).toBe(`${CLOSED} ${NOT_ORDERED}`);
    expect(result.conversation.pendingDealChoice).toBeUndefined();
  });
});

describe('a cart built before closing', () => {
  it('is kept but cannot be placed, and is confirmed afresh once open', () => {
    const company = restaurant();
    const c = reviewedOpen(company);
    for (const extra of [{}, { action: { type: 'confirm', revision: c.cart.revision } as const }]) {
      const late = turn(company, c, 'confirm', pkt('03:01'), undefined, undefined, extra);
      expect(late.order).toBeUndefined();
      expect(late.reply).toBe(`${CLOSED} ${CART_SAVED}`);
      expect(late.conversation.cart.status).toBe('building');
      expect(late.conversation.cart.items).toHaveLength(1);
      // At 15:00 the saved cart is reviewed again before anything is placed.
      const reopened = turn(company, late.conversation, 'confirm', pkt('15:00'));
      expect(reopened.order).toBeUndefined();
      expect(reopened.reply).toContain('Please review your order:');
      expect(turn(company, reopened.conversation, 'confirm', pkt('15:01')).order).toBeDefined();
    }
  });

  it('is shown, or has a dish taken out, with the note that none of it is ordered', () => {
    const company = restaurant();
    const c = reviewedOpen(company);
    const shown = turn(company, c, 'show my cart', pkt('03:10'), [{ type: 'cart_summary' }], {
      text: 'Anything else?',
      askFor: 'anything_else',
    });
    expect(shown.reply).toContain('2 × Chicken Biryani');
    expect(shown.reply).toContain(CART_SAVED);
    expect(shown.reply).not.toContain('Anything else?');
    const two = turn(company, c, 'one more', pkt('02:55'), [
      { type: 'add_item', productId: others[0]!.id, quantity: 1 },
    ]).conversation;
    const fewer = turn(company, two, 'remove it', pkt('03:10'), [
      { type: 'remove_item', productId: others[0]!.id },
    ]);
    expect(fewer.conversation.cart.items.map((i) => i.productId)).toEqual([biryani.id]);
    expect(fewer.reply).toContain(CART_SAVED);
  });

  it('can still be cancelled, also beside a step that is refused', () => {
    const company = restaurant();
    const cancelled = turn(company, reviewedOpen(company), 'cancel', pkt('03:10'), [
      { type: 'add_item', productId: biryani.id, quantity: 1 },
      { type: 'cancel' },
    ]);
    expect(cancelled.conversation.cart.status).toBe('cancelled');
    expect(cancelled.reply).toContain('Your cart has been cancelled.');
    expect(cancelled.reply).not.toContain('Your cart is saved');
  });
});

describe('an order already with the restaurant', () => {
  const placed = () => {
    const company = restaurant({ handoffMessage: OWNER_HANDOFF });
    const result = turn(company, reviewedOpen(company), 'confirm', pkt('02:55'));
    expect(result.order).toBeDefined();
    return { company, c: result.conversation };
  };

  it('is never said not to be ordered', () => {
    const { company, c } = placed();
    const more = turn(company, c, '1 more biryani', pkt('03:05'), [
      { type: 'add_item', productId: biryani.id, quantity: 1 },
    ]);
    expect(more.reply).toContain('This order has already been submitted.');
    expect(more.reply).not.toContain('not been ordered');
    const again = turn(company, c, 'new order', pkt('03:05'), [{ type: 'new_order' }]);
    expect(again.reply).toBe(`${CLOSED} We can’t take a new order until we open.`);
    expect(again.conversation.cart.status).toBe('submitted');
  });

  it('reaches staff with the owner’s own message: they are still finishing orders', () => {
    const { company, c } = placed();
    expect(turn(company, c, 'staff', pkt('03:10'), [{ type: 'handoff' }]).reply).toBe(
      OWNER_HANDOFF,
    );
  });
});

describe('what the bot still does while closed', () => {
  const company = restaurant();
  it('answers a question in the AI’s words, with the closed notice once', () => {
    const ask = (c: Conversation) =>
      turn(company, c, 'is the biryani spicy?', pkt('04:00'), [{ type: 'answer', text: '' }], {
        text: 'It is medium spicy.',
        askFor: 'none',
      });
    const first = ask(fresh());
    expect(first.reply).toContain(CLOSED);
    expect(first.reply).toContain('It is medium spicy.');
    expect(ask(first.conversation).reply).toBe('It is medium spicy.');
  });

  it('shows the menu without asking for an order', () => {
    const result = turn(company, fresh(), 'menu', pkt('04:00'));
    expect(result.reply).toContain('Chicken Biryani');
    expect(result.reply).not.toContain('Tell me the item and quantity');
    expect(turn(company, fresh(), 'menu', pkt('16:00')).reply).toContain(
      'Tell me the item and quantity',
    );
  });

  it.each(['anything_else', 'fulfillment', 'name', 'zone', 'address'] as const)(
    'drops an AI question for %s, and never hands the chat to staff for it',
    (askFor) => {
      const result = turn(company, fresh(), 'ok', pkt('04:00'), [{ type: 'answer', text: '' }], {
        text: 'Noted! What is next?',
        askFor,
      });
      expect(result.reply).toBe(`${CLOSED} ${NOT_ORDERED}`);
      expect(result.conversation.mode).toBe('bot');
      expect(result.decision?.modelText).toBe('protected');
    },
  );

  it('says it is closed again under any reply that asks what they would like', () => {
    const invite = (c: Conversation, text: string) =>
      turn(company, c, text, pkt('04:00'), [{ type: 'answer', text: '' }], {
        text: 'What would you like?',
        askFor: 'items',
      });
    const first = invite(fresh(), 'hello there');
    expect(first.reply).toContain(CLOSED);
    expect(invite(first.conversation, 'hmm').reply).toContain(CLOSED);
  });

  it('never falls back to asking for an order', () => {
    const result = turn(company, fresh(), 'ok', pkt('04:00'), [], { text: '', askFor: 'none' });
    expect(result.reply).toBe(`${CLOSED} ${NOT_ORDERED}`);
  });

  it('keeps the owner’s exact rule wording', () => {
    const rule = {
      id: 'parking',
      enabled: true,
      when: 'The customer asks about parking.',
      action: 'reply' as const,
      response: 'Parking is in front of the shop.',
      responseMode: 'exact' as const,
    };
    const result = turn(
      restaurant({ behaviorRules: [rule] }),
      fresh(),
      'parking?',
      pkt('04:00'),
      [{ type: 'answer', text: '' }],
      { text: 'x', askFor: 'name', matchedRuleId: 'parking' },
    );
    expect(result.reply).toBe('Parking is in front of the shop.');
  });
});

describe('a chat handed to staff while closed', () => {
  it('replaces the owner’s “shortly”, and only while closed', () => {
    const company = restaurant({ handoffMessage: OWNER_HANDOFF });
    const closed = turn(company, fresh(), 'staff', pkt('04:00'), [{ type: 'handoff' }]);
    expect(closed.reply).toBe(`I’ve passed your chat to our team. ${CLOSED} ${TEAM}`);
    expect(closed.decision?.parts).toEqual(['engine']);
    const open = turn(company, fresh(), 'staff', pkt('16:00'), [{ type: 'handoff' }]);
    expect(open.reply).toBe(OWNER_HANDOFF);
    expect(open.decision?.parts).toEqual(['handoff_message']);
  });

  it('says a cart is not an order', () => {
    const company = restaurant({ handoffMessage: OWNER_HANDOFF });
    const result = turn(company, reviewedOpen(company), 'staff', pkt('03:10'), [
      { type: 'handoff' },
    ]);
    expect(result.reply).toBe(
      `I’ve passed your chat to our team. ${CLOSED} ${TEAM} Your order hasn’t been placed yet.`,
    );
  });

  it('keeps exact rule wording and the allergy notice, with the opening time after', () => {
    const rule = {
      id: 'complaint',
      enabled: true,
      when: 'The guest complains.',
      action: 'handoff' as const,
      response: 'I’m really sorry. Our manager will reply here shortly.',
      responseMode: 'exact' as const,
    };
    const company = restaurant({ handoffMessage: OWNER_HANDOFF, behaviorRules: [rule] });
    expect(
      turn(company, fresh(), 'my food was cold', pkt('04:00'), [{ type: 'handoff' }], {
        text: '',
        askFor: 'none',
        matchedRuleId: 'complaint',
      }).reply,
    ).toBe(`${rule.response}\n\n${CLOSED} ${TEAM}`);
    // Without an approved allergy answer, the fixed notice and a person.
    const allergy = turn(
      { ...company, faqs: [] },
      fresh(),
      'I have a nut allergy, is biryani safe?',
      pkt('04:00'),
      [{ type: 'answer', text: '' }],
      { text: 'Let me check.', askFor: 'none' },
    );
    expect(allergy.conversation.mode).toBe('human');
    expect(allergy.reply).toContain('We can’t confirm allergens');
    expect(allergy.reply).toContain(`${CLOSED} ${TEAM}`);
    // Beside a refused dish, closed is said once.
    const both = turn(
      { ...company, faqs: [] },
      fresh(),
      'add a biryani, I have a nut allergy, is it safe?',
      pkt('04:00'),
      [{ type: 'add_item', productId: biryani.id, quantity: 1 }],
      { text: 'Added!', askFor: 'none' },
    );
    expect(both.conversation.mode).toBe('human');
    expect(both.conversation.cart.items).toHaveLength(0);
    expect(both.reply).toContain(NOT_ORDERED);
    expect(both.reply).toContain(TEAM);
    expect(both.reply.split('We are currently closed.')).toHaveLength(2);
  });

  it('says it in the customer’s language', () => {
    for (const [language, words] of [
      ['ur', 'ہماری ٹیم کھلنے کے بعد یہیں جواب دے گی۔'],
      ['roman-ur', 'Hamari team khulne ke baad yahin jawab degi.'],
    ] as const)
      expect(
        turn(restaurant({ language }), fresh(language), 'staff', pkt('04:00')).reply,
      ).toContain(words);
  });
});

describe('the refusal', () => {
  it.each([
    ['en', NOT_ORDERED, CART_SAVED],
    [
      'ur',
      'ابھی آرڈر نہیں لیا جا سکتا، اس لیے یہ آرڈر نہیں ہوا۔ ہمارے کھلنے پر دوبارہ پیغام بھیجیں۔',
      'آپ کی ٹوکری محفوظ ہے، مگر ابھی کچھ آرڈر نہیں ہوا۔ ہمارے کھلنے پر “جائزہ” لکھیں۔',
    ],
    [
      'roman-ur',
      'Abhi order nahi le sakte, is liye yeh order nahi hua. Hamare khulne par dobara message karein.',
      'Aap ka cart save hai, magar abhi kuch order nahi hua. Jab hum khule hon to “review” likhein.',
    ],
  ] as const)('is worded in %s', (lang, empty, saved) => {
    const company = restaurant();
    const line = { productId: biryani.id, quantity: 1, modifierIds: [], notes: '' };
    expect(closedRefusal(company, lang, emptyCart(), pkt('04:00'))).toContain(empty);
    expect(closedRefusal(company, lang, { ...emptyCart(), items: [line] }, pkt('04:00'))).toContain(
      saved,
    );
  });

  it('is explained in plain words in the dashboard', () => {
    expect(describeStep('closed_refused')).toBe('Took no order while closed');
    expect(describeStep('closed_notice')).toBe('Said the restaurant is closed');
    expect(describeCorrection('closed_refused')).toContain('closed');
    const result = turn(restaurant(), fresh(), '2 chicken biryani', pkt('04:00'));
    expect(result.decision?.corrections).toContain('closed_refused');
  });
});

describe('through the service, with an AI model', () => {
  const key = 'fictional-anthropic-key';
  let repo: MemoryRepository;
  let company: Company;
  beforeEach(async () => {
    generate.mockReset();
    repo = new MemoryRepository();
    vi.useFakeTimers({ now: new Date(pkt('04:57')), toFake: ['Date'] });
    vi.stubEnv('APP_MODE', 'demo');
    vi.stubEnv('ORDERLY_RUNTIME', '');
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('APP_URL', 'http://127.0.0.1:5173');
    vi.stubEnv('MODEL_PRICING_JSON', '');
    vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
    await repo.saveIntegration(
      base.id,
      { kind: 'anthropic', configured: true, status: 'connected', config: {} },
      encryptSecret(key),
    );
    const configured = restaurant(
      { handoffMessage: OWNER_HANDOFF },
      {
        botEnabled: true,
        ai: { provider: 'anthropic', model: 'claude-haiku-5-5', monthlyBudgetUsd: 10 },
        privacy: { aiDataApproved: true, retentionDays: 0 },
      },
    );
    company = {
      ...configured,
      modelVerification: {
        fingerprint: modelFingerprint(configured, key),
        checkedAt: new Date().toISOString(),
      },
    };
    await repo.saveCompany(company);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  const send = (text: string, conversation = fresh()) =>
    handleTurn(repo, company, conversation, {
      messageId: randomUUID(),
      text,
      now: new Date().toISOString(),
    });
  const proposes = (output: ModelInterpretation) =>
    generate.mockResolvedValue({ output, usage: { inputTokens: 1200, outputTokens: 80 } });

  it('saves no order and no cart, whatever the AI proposes', async () => {
    proposes({
      actions: [
        { type: 'add_item', productId: biryani.id, quantity: 1 },
        { type: 'set_details', customerName: 'Danish', fulfillment: 'pickup' },
        { type: 'confirm' },
      ],
      response: { text: 'All set!', askFor: 'none' },
    });
    const result = await send('1 biryani, pickup, Danish, confirm');
    expect(result.reply).toContain(`${CLOSED} ${NOT_ORDERED}`);
    expect(result.reply).not.toContain('All set!');
    expect(result.order).toBeUndefined();
    const saved = (await repo.getConversation(base.id, result.conversation.id))!;
    expect(saved.cart.items).toHaveLength(0);
    expect(saved.mode).toBe('bot');
  });

  it('tells the AI its rule in the message while closed only, never in the cached instructions', async () => {
    proposes({ actions: [{ type: 'menu' }], response: { text: 'Here it is.', askFor: 'none' } });
    const instructions: string[] = [];
    const rules: unknown[] = [];
    for (const at of ['04:57', '16:00']) {
      vi.setSystemTime(new Date(pkt(at)));
      generate.mockClear();
      await send('menu bhejo');
      const call = generate.mock.calls[0]![0] as { system: unknown; prompt: string };
      instructions.push(JSON.stringify(call.system));
      const prompt = JSON.parse(call.prompt);
      rules.push(prompt.closedRule);
      expect(prompt.business.currentlyOpen).toBe(at === '16:00');
    }
    expect(rules[0]).toContain('no order can be taken');
    expect(rules[1]).toBeUndefined();
    expect(instructions[0]).toBe(instructions[1]);
  });

  it('says when staff will reply on a notice sent because the AI failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    generate.mockRejectedValue(new Error('overloaded'));
    const closed = await send('hello');
    expect(closed.conversation.mode).toBe('human');
    expect(closed.reply).toContain('A staff member will reply here soon.');
    expect(closed.reply).toContain(`${CLOSED} ${TEAM}`);
    vi.setSystemTime(new Date(pkt('16:00')));
    const open = await send('hello');
    expect(open.reply).toContain('A staff member will reply here soon.');
    expect(open.reply).not.toContain('closed');
  });
});
