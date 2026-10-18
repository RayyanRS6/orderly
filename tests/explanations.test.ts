import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRepository } from '../server/repository';
import { handleTurn } from '../server/service';
import { APICallError } from 'ai';
import { PublicError, encryptSecret } from '../server/security';
import { modelFingerprint } from '../server/integrations/model-catalog';
import { createConversation, processTurn } from '../src/domain/engine';
import { defaultBot } from '../src/shared/bot';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import {
  describeConfig,
  describeCorrection,
  describeStep,
  explanationHeadline,
  explanationPath,
  MODEL_TEXT_LABELS,
  NOTICE_LABELS,
  PART_LABELS,
  SKIP_LABELS,
} from '../src/shared/explain';
import { ReplyExplanation, WhyToggle } from '../src/components/ReplyExplanation';
import type {
  BehaviorRule,
  BotAction,
  BotConfig,
  Company,
  Conversation,
  ModelInterpretation,
  ModelResponse,
  TurnExplanation,
} from '../src/shared/types';

const { generate } = vi.hoisted(() => ({ generate: vi.fn() }));
// Keep the real error classes: the adapter uses them to decide what a failed call cost.
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: generate,
  Output: { object: vi.fn() },
}));

const company = seedCompanies[0]!;
const products = seedProducts.filter((p) => p.companyId === company.id);
const biryani = products.find((p) => p.name === 'Chicken Biryani')!;
const daal = products.find((p) => p.name === 'Daal Makhani')!;
const now = '2026-09-09T13:30:00.000Z';
const fresh = (): Conversation => createConversation(company.id, '923000000555', 'demo', now);
const publishedBot = (config: Partial<BotConfig>): Company => {
  const bot = { ...defaultBot, ...config };
  return {
    ...company,
    bot: {
      draft: bot,
      revision: 1,
      history: [],
      published: { version: 1, config: bot, publishedAt: now, publishedBy: 'test' },
    },
  };
};
const turn = (
  target: Company,
  text: string,
  actions?: BotAction[],
  response?: ModelResponse,
  conversation: Conversation = fresh(),
) =>
  processTurn(
    target,
    products,
    conversation,
    { messageId: `message-${randomUUID()}`, text, now },
    actions,
    response,
  );
const parking: BehaviorRule = {
  id: 'parking',
  enabled: true,
  when: 'Customer asks about parking',
  action: 'reply',
  responseMode: 'exact',
  response: 'Free parking is available behind the restaurant.',
};
const upsell: BehaviorRule = {
  id: 'upsell',
  enabled: true,
  when: 'Customer adds a main dish',
  action: 'continue',
  responseMode: 'exact',
  response: 'Would you like a Mango Lassi with that?',
};

describe('engine reply decision', () => {
  it('credits the AI model when its grounded answer is sent', () => {
    const result = turn(company, 'when are you open?', [{ type: 'answer', text: '' }], {
      text: 'We are open all day for testing.',
      askFor: 'none',
      groundingIds: ['business:hours'],
    });
    expect(result.reply).toBe('We are open all day for testing.');
    expect(result.decision).toEqual({ parts: ['model'], modelText: 'used', corrections: [] });
  });

  it('credits the AI model for an answer it wrote without a separate reply object', () => {
    const result = turn(company, 'is there parking nearby?', [
      { type: 'answer', text: 'Yes, there is street parking nearby.' },
    ]);
    expect(result.reply).toBe('Yes, there is street parking nearby.');
    expect(result.decision).toEqual({ parts: ['model'], modelText: 'used', corrections: [] });
  });

  it('reports an unsafe answer the AI wrote without a separate reply object', () => {
    const result = turn(company, 'how much is it?', [
      { type: 'answer', text: 'It costs Rs. 500 in total.' },
    ]);
    expect(result.reply).not.toContain('Rs. 500');
    expect(result.decision?.parts).not.toContain('model');
    expect(result.decision?.modelText).toBe('unsafe');
    expect(result.decision?.corrections).toContain('unsafe_model_response_ignored');
  });

  it('credits the engine for cart lines and the model for the follow-up question', () => {
    const result = turn(
      company,
      'two chicken biryani please',
      [{ type: 'add_item', productId: biryani.id, quantity: 2 }],
      { text: 'Would you like anything else?', askFor: 'anything_else' },
    );
    expect(result.reply).toContain('Added 2 × Chicken Biryani');
    expect(result.reply.endsWith('Would you like anything else?')).toBe(true);
    expect(result.decision).toEqual({
      parts: ['engine', 'model'],
      modelText: 'used',
      corrections: [],
    });
  });

  it('sends an exact rule’s words instead of the model’s and records the rule', () => {
    const result = turn(
      publishedBot({ behaviorRules: [parking] }),
      'is there parking?',
      [{ type: 'answer', text: '' }],
      { text: 'Yes, there is parking nearby.', askFor: 'none', matchedRuleId: 'parking' },
    );
    expect(result.reply).toBe(parking.response);
    expect(result.traces).toContain('behavior_rule:parking');
    expect(result.decision).toEqual({
      parts: ['exact_rule'],
      modelText: 'exact_rule',
      matchedRule: {
        id: 'parking',
        when: 'Customer asks about parking',
        action: 'reply',
        responseMode: 'exact',
      },
      corrections: [],
    });
  });

  it('keeps the engine’s cart lines before an exact rule on a transactional turn', () => {
    const result = turn(
      publishedBot({ behaviorRules: [upsell] }),
      'one chicken biryani',
      [{ type: 'add_item', productId: biryani.id, quantity: 1 }],
      { text: 'Anything else?', askFor: 'anything_else', matchedRuleId: 'upsell' },
    );
    expect(result.reply).toContain('Added 1 × Chicken Biryani');
    expect(result.reply.endsWith(upsell.response)).toBe(true);
    expect(result.decision).toMatchObject({
      parts: ['engine', 'exact_rule'],
      modelText: 'exact_rule',
      matchedRule: { id: 'upsell', action: 'continue', responseMode: 'exact' },
    });
  });

  it.each(['That comes to Rs. 500 in total.', 'Thanks, your order confirmed!'])(
    'drops unsafe model wording: %s',
    (text) => {
      const result = turn(company, 'what do I owe you?', [{ type: 'answer', text: '' }], {
        text,
        askFor: 'none',
      });
      expect(result.reply).not.toContain(text);
      expect(result.decision?.modelText).toBe('unsafe');
      expect(result.decision?.corrections).toContain('unsafe_model_response_ignored');
      expect(result.decision?.parts).not.toContain('model');
    },
  );

  it('drops model wording that cites facts the business never provided', () => {
    const result = turn(company, 'do you have valet parking?', [{ type: 'answer', text: '' }], {
      text: 'Yes, valet parking is free.',
      askFor: 'none',
      groundingIds: ['business:valet'],
    });
    expect(result.reply).not.toContain('valet');
    expect(result.decision?.modelText).toBe('ungrounded');
    expect(result.decision?.corrections).toContain('invalid_model_grounding_ignored');
  });

  it('drops a model question for a detail the customer already gave', () => {
    const conversation = fresh();
    conversation.cart.items = [{ productId: biryani.id, quantity: 1, modifierIds: [], notes: '' }];
    conversation.cart.fulfillment = 'pickup';
    const result = turn(
      company,
      'thanks',
      [{ type: 'answer', text: '' }],
      { text: 'Pickup or delivery?', askFor: 'fulfillment' },
      conversation,
    );
    expect(result.decision?.modelText).toBe('invalid_question');
    expect(result.decision?.corrections).toContain('invalid_model_prompt_ignored');
  });

  it('protects an engine rejection from the model’s wording', () => {
    const result = turn(
      company,
      'one daal makhani',
      [{ type: 'add_item', productId: daal.id, quantity: 1 }],
      { text: 'Lovely choice!', askFor: 'none' },
    );
    expect(result.conversation.cart.items).toEqual([]);
    expect(result.decision).toEqual({
      parts: ['engine'],
      modelText: 'protected',
      corrections: ['validation_failed:add_item'],
    });
  });

  it('replaces the reply with the published greeting for a plain “hi”', () => {
    const greeting = 'Assalam o alaikum! Welcome to Dastarkhwan.';
    const withModel = turn(publishedBot({ greeting }), 'hi', [{ type: 'answer', text: '' }], {
      text: 'Hello! What would you like to order today?',
      askFor: 'items',
    });
    expect(withModel.reply).toBe(greeting);
    expect(withModel.decision).toEqual({
      parts: ['greeting'],
      modelText: 'replaced',
      corrections: [],
    });
    const withoutModel = turn(publishedBot({ greeting }), 'hi');
    expect(withoutModel.reply).toBe(greeting);
    expect(withoutModel.decision).toMatchObject({ parts: ['greeting'], modelText: 'none' });
  });

  it('credits only the engine for a deterministic menu button', () => {
    const result = processTurn(company, products, fresh(), {
      messageId: 'menu-button',
      text: 'menu',
      now,
      action: { type: 'menu' },
    });
    expect(result.reply).toContain('Chicken Biryani');
    expect(result.decision).toEqual({ parts: ['engine'], modelText: 'none', corrections: [] });
  });

  it('records no reply parts while staff handle the chat or replies are paused', () => {
    const human = fresh();
    human.mode = 'human';
    for (const [target, conversation] of [
      [company, human],
      [{ ...company, botEnabled: false }, fresh()],
    ] as const) {
      const result = turn(target, 'hello?', undefined, undefined, conversation);
      expect(result.reply).toBe('');
      expect(result.decision?.parts ?? []).toEqual([]);
      expect(result.traces).toContain('human_mode_message_saved');
    }
  });
});

const explanation = (overrides: Partial<TurnExplanation> = {}): TurnExplanation => ({
  v: 1,
  channel: 'demo',
  config: { target: 'draft', revision: 3 },
  provider: 'anthropic',
  model: 'claude-haiku-5-5',
  catalogSource: 'app',
  ai: { called: true, proposed: [{ type: 'confirm' }] },
  steps: ['confirm', 'order_pending_restaurant_acceptance'],
  decision: { parts: ['engine'], modelText: 'protected', corrections: [] },
  outcome: 'reply',
  ...overrides,
});
const aiNodes = ['agent', 'model', 'memory', 'menu', 'knowledge', 'instructions'];

describe('explanation wording and flow path', () => {
  it('traces a sandbox order through the model and order nodes without the Sheet', () => {
    const path = explanationPath(explanation({ outcome: 'order', orderReference: 'ORD-1A2B3C4D' }));
    expect(path.stoppedAt).toBeUndefined();
    expect(path.nodes).toEqual([
      'sandbox',
      'gates',
      ...aiNodes,
      'engine',
      'router',
      'reply',
      'order',
    ]);
    expect(path.nodes).not.toContain('sheets');
    expect(path.nodes).not.toContain('channel');
  });

  it('includes the Sheet for a WhatsApp order', () => {
    const path = explanationPath(explanation({ channel: 'whatsapp', outcome: 'order' }));
    expect(path.nodes[0]).toBe('channel');
    expect(path.nodes).not.toContain('sandbox');
    expect(path.nodes.slice(-2)).toEqual(['order', 'sheets']);
  });

  it('skips the AI nodes for a button tap and adds staff for a handoff', () => {
    expect(
      explanationPath(explanation({ ai: { called: false, skipped: 'button' } })).nodes,
    ).toEqual(['sandbox', 'gates', 'engine', 'router', 'reply']);
    expect(explanationPath(explanation({ outcome: 'staff' })).nodes.at(-1)).toBe('staff');
  });

  it('stops a burst at the safety checks and an AI failure at the model', () => {
    const staff = { channel: 'whatsapp', outcome: 'staff', ai: { called: false } } as const;
    expect(explanationPath(explanation({ ...staff, notice: 'burst' }))).toEqual({
      nodes: ['channel', 'gates', 'router', 'reply', 'staff'],
      stoppedAt: 'gates',
    });
    expect(explanationPath(explanation({ ...staff, notice: 'menu_sync' }))).toEqual({
      nodes: ['channel', 'gates', 'menu', 'router', 'reply', 'staff'],
      stoppedAt: 'menu',
    });
    for (const notice of ['ai_error', 'ai_budget', 'hourly_limit', 'customer_limit'] as const) {
      const path = explanationPath(explanation({ ...staff, notice }));
      expect(path.stoppedAt).toBe('model');
      expect(path.nodes).toEqual(['channel', 'gates', ...aiNodes, 'router', 'reply', 'staff']);
      expect(path.nodes).not.toContain('engine');
    }
  });

  it('writes a headline for orders, rules, notices and reply parts', () => {
    expect(
      explanationHeadline(explanation({ outcome: 'order', orderReference: 'ORD-1A2B3C4D' })),
    ).toBe('The customer confirmed, so order ORD-1A2B3C4D was saved for staff to accept.');
    expect(explanationHeadline(explanation({ outcome: 'order' }))).toBe(
      'The customer confirmed, so the order was saved for staff to accept.',
    );
    const ruled = (
      rule: TurnExplanation['decision']['matchedRule'],
      parts: TurnExplanation['decision']['parts'] = ['exact_rule'],
      outcome: TurnExplanation['outcome'] = 'reply',
    ) =>
      explanationHeadline(
        explanation({
          outcome,
          decision: {
            parts,
            modelText: parts.includes('exact_rule') ? 'exact_rule' : 'protected',
            matchedRule: rule,
            corrections: [],
          },
        }),
      );
    expect(
      ruled({ id: 'parking', when: parking.when, action: 'reply', responseMode: 'exact' }),
    ).toBe(
      'Your rule “Customer asks about parking” matched, so the bot replied without changing the order using your exact words.',
    );
    expect(
      ruled(
        {
          id: 'manager',
          when: 'Customer asks for a manager',
          action: 'handoff',
          responseMode: 'adaptive',
        },
        ['handoff_message'],
        'staff',
      ),
    ).toBe('Your rule “Customer asks for a manager” matched, so the bot handed the chat to staff.');
    expect(
      ruled({ id: 'upsell', when: upsell.when, action: 'continue', responseMode: 'exact' }),
    ).toBe(
      'Your rule “Customer adds a main dish” matched, so the bot continued the order using your exact words.',
    );
    // The engine kept its own exact reply (for example a sold-out item), so the rule's words were not used.
    expect(
      ruled({ id: 'upsell', when: upsell.when, action: 'continue', responseMode: 'exact' }, [
        'engine',
      ]),
    ).toBe(
      'Your rule “Customer adds a main dish” matched, but this reply came from Orderly’s order engine instead.',
    );
    // A reply rule matched, but the turn still ended with staff.
    expect(
      ruled(
        { id: 'parking', when: parking.when, action: 'reply', responseMode: 'exact' },
        ['engine'],
        'staff',
      ),
    ).toBe('Your rule “Customer asks about parking” matched, but the chat was handed to staff.');
    expect(explanationHeadline(explanation({ notice: 'ai_error', outcome: 'staff' }))).toBe(
      NOTICE_LABELS.ai_error,
    );
    expect(NOTICE_LABELS.ai_error).toMatch(/^The AI model could not answer, so the chat paused/);
    expect(explanationHeadline(explanation({ notice: 'burst', outcome: 'staff' }))).toBe(
      'Many messages arrived within a minute, so automatic replies to this customer paused for 15 minutes.',
    );
    expect(explanationHeadline(explanation({ outcome: 'staff' }))).toBe(
      'The chat was handed to staff.',
    );
    expect(
      explanationHeadline(
        explanation({
          decision: { parts: ['engine', 'model'], modelText: 'used', corrections: [] },
        }),
      ),
    ).toBe('Written by Orderly’s order engine + the AI model.');
    expect(
      explanationHeadline(
        explanation({ decision: { parts: [], modelText: 'none', corrections: [] } }),
      ),
    ).toBe('No reply text.');
  });

  it('describes corrections, steps and the settings used', () => {
    expect(describeCorrection('validation_failed:add_item')).toBe(
      'The engine rejected a proposed “add item” (for example a sold-out item, a closed restaurant or a missing detail).',
    );
    expect(describeCorrection('unsafe_model_response_ignored')).toBe(
      'The AI’s wording stated prices or a confirmation, so it was dropped.',
    );
    expect(describeCorrection('a_future_correction')).toBe('a future correction');
    expect(describeStep('behavior_rule:parking')).toBe('Matched your rule');
    expect(describeStep('validation_failed:set_details')).toBe('Rejected set details');
    expect(describeStep('cancel_submitted:order-1')).toBe('Passed the cancellation to staff');
    expect(describeStep('order_cancelled')).toBe('Cancelled the order');
    expect(describeStep('add_item')).toBe('Added to cart');
    expect(describeStep('unknown_step')).toBe('unknown step');
    expect(describeConfig(explanation())).toBe(
      'Draft settings (revision 3) · Anthropic claude-haiku-5-5',
    );
    // Replies saved before keys became business-only still carry the old label.
    const older = { ...explanation(), keyMode: 'platform' } as TurnExplanation;
    expect(describeConfig(older)).toBe('Draft settings (revision 3) · Anthropic claude-haiku-5-5');
    expect(
      describeConfig(explanation({ config: { target: 'live', revision: 4, version: 2 } })),
    ).toBe('Live settings v2 · Anthropic claude-haiku-5-5');
    expect(
      describeConfig(explanation({ config: { target: 'live', revision: 0 }, provider: 'mock' })),
    ).toBe('Default settings (nothing published) · no AI model');
  });

  it('describes menu page orders and invented links', () => {
    expect(SKIP_LABELS.menu_page).toBe(
      'The customer ordered from your menu page, so no AI was needed.',
    );
    expect(MODEL_TEXT_LABELS.unsafe).toBe(
      'The AI’s wording mentioned prices, totals, a confirmed order or a web link you didn’t provide, so it was dropped.',
    );
    expect(describeCorrection('invented_link_ignored')).toBe(
      'The AI’s wording included a web link you didn’t provide, so it was dropped.',
    );
    expect(describeStep('menu_page_order')).toBe('Saved an order from the menu page');
  });
});

describe('ReplyExplanation component', () => {
  it('renders the headline, settings, writers, AI usage and corrections', () => {
    const value = explanation({
      ai: {
        called: true,
        proposed: [{ type: 'add_item', productId: biryani.id, quantity: 2 }],
        askFor: 'fulfillment',
        usage: {
          inputTokens: 1200,
          outputTokens: 80,
          costUsd: 0.00016,
          durationMs: 420,
          estimated: false,
        },
      },
      steps: ['add_item', 'validation_failed:add_item'],
      decision: {
        parts: ['engine', 'model'],
        modelText: 'used',
        corrections: ['validation_failed:add_item', 'invalid_model_prompt_ignored'],
      },
    });
    const html = renderToStaticMarkup(createElement(ReplyExplanation, { explanation: value }));
    expect(html).toContain('Written by Orderly’s order engine + the AI model.');
    expect(html).toContain('Settings used');
    expect(html).toContain('Draft settings (revision 3) · Anthropic claude-haiku-5-5');
    expect(html).not.toContain('Orderly key');
    expect(html).toContain(PART_LABELS.engine);
    expect(html).toContain(PART_LABELS.model);
    expect(html).toContain('Add item');
    expect(html).toContain('Asked the customer for: Fulfillment.');
    expect(html).toContain('1,200');
    expect(html).toContain('Corrected by the order engine');
    expect(html).toContain(describeCorrection('validation_failed:add_item'));
    expect(html).toContain(describeCorrection('invalid_model_prompt_ignored'));
    expect(html).toContain('Rejected add item');
    expect(html).not.toContain('AI wording');
    expect(html).not.toContain('reused');
  });

  it('shows how many prompt tokens were reused from the cache', () => {
    const value = explanation({
      ai: {
        called: true,
        usage: {
          inputTokens: 3200,
          cacheReadTokens: 900,
          outputTokens: 80,
          costUsd: 0.0001,
          durationMs: 420,
          estimated: false,
        },
      },
    });
    const html = renderToStaticMarkup(createElement(ReplyExplanation, { explanation: value }));
    expect(html).toContain('3,200 in (900 reused) / 80 out tokens');
  });

  it('explains a rule and the fate of the AI wording', () => {
    const value = explanation({
      decision: {
        parts: ['exact_rule'],
        modelText: 'exact_rule',
        matchedRule: { id: 'parking', when: parking.when, action: 'reply', responseMode: 'exact' },
        corrections: [],
      },
    });
    const html = renderToStaticMarkup(createElement(ReplyExplanation, { explanation: value }));
    expect(html).toContain('Your rule');
    expect(html).toContain('exact words');
    expect(html).toContain(PART_LABELS.exact_rule);
    expect(html).toContain('AI wording');
    expect(html).toContain(MODEL_TEXT_LABELS.exact_rule);
  });

  it('starts the “Why this reply?” toggle closed', () => {
    const html = renderToStaticMarkup(
      createElement(WhyToggle, { explanation: explanation({ outcome: 'order' }) }),
    );
    expect(html).toContain('Why this reply?');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('Settings used');
  });
});

describe('handleTurn reply explanations', () => {
  const key = 'fictional-anthropic-key';
  const name = 'Ayesha Siddiqui';
  const address = 'House 42, Street 7, Gulberg III';
  const personal = /Ayesha|Siddiqui|House 42|Street 7/;
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
      encryptSecret(key),
    );
    const base: Company = {
      ...company,
      ai: {
        provider: 'anthropic',
        model: 'claude-haiku-5-5',
        monthlyBudgetUsd: 10,
      },
      privacy: { aiDataApproved: true, retentionDays: 0 },
      bot: { draft: { ...defaultBot }, revision: 2, history: [] },
    };
    configured = {
      ...base,
      modelVerification: { fingerprint: modelFingerprint(base, key), checkedAt: now },
    };
    await repo.saveCompany(configured);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function send(
    conversation: Conversation,
    text: string,
    interpretation?: ModelInterpretation,
    usage = { inputTokens: 1200, outputTokens: 80 },
  ) {
    if (interpretation) generate.mockResolvedValueOnce({ output: interpretation, usage });
    const messageId = randomUUID();
    const result = await handleTurn(repo, configured, conversation, {
      messageId,
      text,
      now: new Date().toISOString(),
    });
    const saved = (await repo.getConversation(company.id, result.conversation.id))!;
    return { result, saved, message: saved.messages.find((m) => m.id === `${messageId}:reply`) };
  }

  it('saves an explanation on each sandbox reply and links the confirmed order', async () => {
    const start = createConversation(company.id, '923001112223', 'demo', new Date().toISOString());
    const first = await send(start, 'two chicken biryani', {
      actions: [{ type: 'add_item', productId: biryani.id, quantity: 2 }],
      response: { text: 'Would you like pickup or delivery?', askFor: 'fulfillment' },
    });
    expect(first.message?.explanation).toEqual(first.result.explanation);
    expect(first.result.explanation).toMatchObject({
      v: 1,
      channel: 'demo',
      config: { target: 'draft', revision: 2 },
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
      catalogSource: 'app',
      ai: {
        called: true,
        proposed: [{ type: 'add_item', productId: biryani.id, quantity: 2 }],
        askFor: 'fulfillment',
        usage: { inputTokens: 1200, outputTokens: 80, estimated: false },
      },
      outcome: 'reply',
    });
    expect(first.result.explanation?.config).toEqual({ target: 'draft', revision: 2 });
    expect(first.result.explanation?.ai.usage?.costUsd).toBeCloseTo(
      (1200 * 0.1 + 80 * 0.5) / 1_000_000,
      12,
    );
    expect(first.result.explanation?.decision).toEqual({
      parts: ['engine', 'model'],
      modelText: 'used',
      corrections: [],
    });
    expect(first.result.explanation?.decision).toEqual(first.result.decision);
    expect(first.result.explanation?.steps).toEqual(first.result.traces);

    const second = await send(first.result.conversation, `Deliver to ${address}. Name: ${name}`, {
      actions: [
        {
          type: 'set_details',
          fulfillment: 'delivery',
          customerName: name,
          zone: 'Gulberg',
          address,
        },
        { type: 'review' },
      ],
      response: { text: '', askFor: 'none' },
    });
    expect(second.saved.cart.status).toBe('awaiting_confirmation');
    expect(second.message?.text).toContain(name);
    expect(second.result.explanation?.ai.proposed).toEqual([
      { type: 'set_details' },
      { type: 'review' },
    ]);
    expect(second.result.explanation?.decision).toEqual({
      parts: ['engine'],
      modelText: 'none',
      corrections: [],
    });

    const third = await send(second.result.conversation, 'confirm', {
      actions: [{ type: 'confirm' }],
      response: { text: 'Great, sending it to the kitchen.', askFor: 'none' },
    });
    const order = third.result.order!;
    expect(order).toBeDefined();
    expect(third.message?.explanation).toEqual(third.result.explanation);
    expect(third.result.explanation).toMatchObject({
      outcome: 'order',
      orderReference: order.reference,
      ai: { called: true, proposed: [{ type: 'confirm' }] },
      decision: { parts: ['engine'], modelText: 'protected', corrections: [] },
    });
    expect((await repo.getOrder(company.id, order.id))?.reference).toBe(order.reference);
    expect(explanationHeadline(third.result.explanation!)).toBe(
      `The customer confirmed, so order ${order.reference} was saved for staff to accept.`,
    );
    expect(explanationPath(third.result.explanation!).nodes).toContain('order');
    expect(generate).toHaveBeenCalledTimes(3);
    for (const step of [first, second, third]) {
      expect(JSON.stringify(step.result.explanation)).not.toMatch(personal);
      expect(JSON.stringify(step.message?.explanation)).not.toMatch(personal);
    }
  });

  it('records that a button tap skipped the AI model', async () => {
    const messageId = randomUUID();
    const tapped = await handleTurn(
      repo,
      configured,
      createConversation(company.id, '923001112225', 'demo', new Date().toISOString()),
      { messageId, text: 'menu', action: { type: 'menu' }, now: new Date().toISOString() },
    );
    expect(generate).not.toHaveBeenCalled();
    expect(tapped.explanation?.ai).toEqual({ called: false, skipped: 'button' });
    expect(tapped.explanation?.decision).toEqual({
      parts: ['engine'],
      modelText: 'none',
      corrections: [],
    });
    expect(tapped.explanation?.outcome).toBe('reply');
    const saved = await repo.getConversation(company.id, tapped.conversation.id);
    expect(saved?.messages.find((m) => m.id === `${messageId}:reply`)?.explanation).toEqual(
      tapped.explanation,
    );
    expect(explanationPath(tapped.explanation!).nodes).toEqual([
      'sandbox',
      'gates',
      'engine',
      'router',
      'reply',
    ]);
  });

  it('records that a late message was handed to staff without the AI', async () => {
    const late = await handleTurn(
      repo,
      configured,
      createConversation(company.id, '923001112226', 'demo', new Date().toISOString()),
      {
        messageId: randomUUID(),
        text: 'hello?',
        late: true,
        // Only a message more than 2 hours late is passed to staff.
        now: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      },
    );
    expect(generate).not.toHaveBeenCalled();
    expect(late.explanation?.ai).toEqual({ called: false, skipped: 'late' });
    expect(late.explanation?.outcome).toBe('staff');
  });

  it('records the published version when testing the published settings', async () => {
    const saved = (await repo.getCompany(company.id))!;
    const config = { ...defaultBot, greeting: 'Published greeting.' };
    expect(
      await repo.saveBot(
        company.id,
        {
          draft: config,
          revision: 3,
          history: [],
          published: { version: 3, config, publishedAt: now, publishedBy: 'test' },
        },
        saved.bot!.revision,
      ),
    ).toBe(true);
    const result = await handleTurn(
      repo,
      configured,
      createConversation(company.id, '923001112226', 'demo', new Date().toISOString()),
      {
        messageId: randomUUID(),
        text: 'menu',
        action: { type: 'menu' },
        now: new Date().toISOString(),
        testTarget: 'published',
      },
    );
    expect(result.explanation?.config).toEqual({ target: 'published', revision: 3, version: 3 });
    expect(describeConfig(result.explanation!)).toBe(
      'Published settings v3 · Anthropic claude-haiku-5-5',
    );
  });

  it.each([
    {
      cause: 'a model error',
      notice: 'ai_error',
      fail: () => generate.mockRejectedValueOnce(new Error('upstream failure')),
    },
    {
      cause: 'a provider rate limit',
      notice: 'ai_error',
      fail: () =>
        generate.mockRejectedValueOnce(
          new APICallError({
            message: 'rate limited',
            url: 'https://api.anthropic.com/v1/messages',
            requestBodyValues: {},
            statusCode: 429,
            responseBody: '{"type":"error","error":{"type":"rate_limit_error"}}',
          }),
        ),
    },
    {
      cause: 'the monthly budget',
      notice: 'ai_budget',
      fail: (target: MemoryRepository) =>
        vi
          .spyOn(target, 'reserveAiCall')
          .mockResolvedValue({ ok: false, limit: 'monthly', limitValue: 10 }),
    },
    {
      cause: 'the hourly AI replies',
      notice: 'hourly_limit',
      fail: (target: MemoryRepository) =>
        vi
          .spyOn(target, 'reserveAiCall')
          .mockResolvedValue({ ok: false, limit: 'hourly', limitValue: 300 }),
    },
    {
      cause: 'one customer’s AI replies',
      notice: 'customer_limit',
      fail: (target: MemoryRepository) =>
        vi
          .spyOn(target, 'reserveAiCall')
          .mockResolvedValue({ ok: false, limit: 'customer', limitValue: 30 }),
    },
  ] as const)('hands a WhatsApp chat to staff after $cause', async ({ notice, fail }) => {
    fail(repo);
    const conversation = createConversation(
      company.id,
      '923001112227',
      'whatsapp',
      new Date().toISOString(),
    );
    const { result, saved } = await send(conversation, `Two biryani for ${name} at ${address}`);
    expect(result.conversation.mode).toBe('human');
    expect(saved.mode).toBe('human');
    expect(result.explanation).toMatchObject({
      channel: 'whatsapp',
      config: { target: 'live', revision: 2 },
      ai: { called: false },
      steps: ['staff_attention'],
      decision: { parts: ['notice'], modelText: 'none', corrections: [] },
      outcome: 'staff',
      notice,
    });
    const last = saved.messages.at(-1);
    expect(last?.role).toBe('assistant');
    expect(last?.explanation).toEqual(result.explanation);
    expect(JSON.stringify(result.explanation)).not.toMatch(personal);
    expect(explanationHeadline(result.explanation!)).toBe(NOTICE_LABELS[notice]);
    expect(explanationPath(result.explanation!).stoppedAt).toBe('model');
    const jobs = await repo.listCompanyJobs(company.id);
    expect(jobs).toContainEqual(
      expect.objectContaining({
        kind: 'whatsapp_send',
        payload: expect.objectContaining({ source: 'notice', messageId: last?.id }),
      }),
    );
  });
});
