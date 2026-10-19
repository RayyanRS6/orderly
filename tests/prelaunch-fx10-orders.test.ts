// Final review, fx-10 (conversation-5): when an order staff never closed stops holding the cart,
// the cart is fresh before the AI sees the chat, and the AI may not say the new, unconfirmed
// order was placed or received. Status questions and cancels still reach the old order.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MemoryRepository } from '../server/repository';
import { encryptSecret } from '../server/security';
import { handleTurn } from '../server/service';
import { modelFingerprint } from '../server/integrations/model-catalog';
import { createConversation, processTurn } from '../src/domain/engine';
import { defaultBot } from '../src/shared/bot';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import type {
  BotAction,
  Company,
  Conversation,
  ModelInterpretation,
  Order,
} from '../src/shared/types';
import { at, latest, placed, turn } from './helpers/fx6-turns';

const { generate } = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: generate,
  Output: { object: vi.fn() },
}));

const company = seedCompanies[0]!;
const products = seedProducts.filter((p) => p.companyId === company.id);
const biryani = products.find((p) => p.name === 'Chicken Biryani')!;
const addTwo: BotAction[] = [{ type: 'add_item', productId: biryani.id, quantity: 2 }];
const CLAIMS = [
  'Your order has been placed! Anything else?',
  'Your order is received.',
  'Aap ka order receive ho gaya hai.',
];

describe('fx-10: no “order placed” for the fresh cart that replaces an order left open', () => {
  it.each(CLAIMS)('drops “%s” once a 16-hour-old ready order lets a new cart start', (text) => {
    const { conversation, order } = placed();
    const result = turn(
      company,
      conversation,
      '2 chicken biryani',
      { latestOrder: latest(order, 'ready', at(-16)) },
      addTwo,
      { text, askFor: 'anything_else' },
    );
    expect(result.conversation.cart).toMatchObject({ status: 'building' });
    expect(result.reply).toContain('Added 2 × Chicken Biryani');
    expect(result.reply).not.toContain(text);
    expect(result.decision?.corrections).toContain('unsafe_model_response_ignored');
    expect(result.order).toBeUndefined();
  });

  it('still drops it while the order holds the cart', () => {
    const { conversation, order } = placed();
    const text = 'Your order has been placed! Anything else?';
    const result = turn(
      company,
      conversation,
      '2 chicken biryani',
      { latestOrder: latest(order, 'ready', at(-11)) },
      addTwo,
      { text, askFor: 'anything_else' },
    );
    expect(result.conversation.cart.status).toBe('submitted');
    expect(result.reply).not.toContain(text);
  });

  it('keeps a true “it was placed” about the order still with the restaurant', () => {
    const { conversation, order } = placed();
    const text = 'Yes, your order has been placed. The restaurant will reply here soon.';
    const result = turn(
      company,
      conversation,
      'did it go through?',
      { latestOrder: latest(order, 'pending', at(-1)) },
      [{ type: 'answer', text: '' }],
      { text, askFor: 'none' },
    );
    expect(result.reply).toBe(text);
  });
});

describe('fx-10: the server starts the fresh cart before the AI is asked', () => {
  const key = 'fictional-anthropic-key';
  const ai = (interpretation: ModelInterpretation) =>
    generate.mockResolvedValue({
      output: interpretation,
      usage: { inputTokens: 1000, outputTokens: 50 },
    });
  let repo: MemoryRepository;
  let configured: Company;

  beforeEach(async () => {
    generate.mockReset();
    repo = new MemoryRepository();
    vi.stubEnv('APP_MODE', 'demo');
    vi.stubEnv('ORDERLY_RUNTIME', '');
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('APP_URL', 'http://127.0.0.1:5173');
    vi.stubEnv('MODEL_PRICING_JSON', '');
    vi.stubEnv('ORDERLY_PAUSE_AUTOMATION', '');
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
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  let phones = 0;
  async function message(conversation: Conversation, text: string) {
    const current = (await repo.getConversation(company.id, conversation.id)) ?? conversation;
    const result = await handleTurn(repo, configured, current, {
      messageId: randomUUID(),
      text,
      now: new Date().toISOString(),
    });
    return { result, saved: (await repo.getConversation(company.id, conversation.id))! };
  }
  async function leftOpen(status: Order['status'], hoursAgo: number) {
    let c: Conversation = {
      ...createConversation(
        company.id,
        `9230077${String(++phones).padStart(5, '0')}`,
        'whatsapp',
        '1970-01-01T00:00:00.000Z',
      ),
      version: 0,
    };
    const step = (action: BotAction) => {
      const result = processTurn(configured, products, c, {
        messageId: randomUUID(),
        text: action.type === 'confirm' ? 'confirm' : 'step',
        action,
        now: new Date().toISOString(),
      });
      c = result.conversation;
      return result;
    };
    step({ type: 'add_item', productId: biryani.id, quantity: 1 });
    step({ type: 'set_details', customerName: 'Ali Raza', fulfillment: 'pickup' });
    step({ type: 'review' });
    const order = step({ type: 'confirm' }).order!;
    c.version = 1;
    await repo.commitTurn(company.id, c, 0, order);
    const updatedAt = new Date(Date.now() - hoursAgo * 3600000).toISOString();
    await repo.saveOrder({ ...order, status, updatedAt });
    return { conversation: c, order };
  }
  const prompt = () => (generate.mock.calls[0]![0] as { prompt: string }).prompt;

  it('shows the AI a building cart, and drops its “order placed” for it', async () => {
    const { conversation, order } = await leftOpen('ready', 14);
    ai({
      actions: addTwo,
      response: { text: 'Your order has been placed! Anything else?', askFor: 'anything_else' },
    });
    const { result, saved } = await message(conversation, '2 chicken biryani');
    expect(prompt()).toContain('"status":"building"');
    expect(prompt()).not.toContain('"status":"submitted"');
    expect(saved.cart).toMatchObject({ status: 'building', items: [{ quantity: 2 }] });
    expect(saved.cart.orderId).toBeUndefined();
    expect(result.reply).toContain('Added 2 × Chicken Biryani');
    expect(result.reply).not.toContain('Your order has been placed');
    expect((await repo.getOrder(company.id, order.id))!.status).toBe('ready');
  });

  it('keeps the cart for a status question or a cancel about that order', async () => {
    const asked = await leftOpen('ready', 14);
    ai({ actions: [{ type: 'answer', text: '' }], response: { text: '', askFor: 'none' } });
    const status = await message(asked.conversation, 'where is my order?');
    expect(status.saved.cart.orderId).toBe(asked.order.id);
    expect(status.result.reply).toContain(asked.order.reference);
    const cancelled = await leftOpen('ready', 14);
    const cancel = await message(cancelled.conversation, 'cancel my order');
    expect(cancel.saved.cart.orderId).toBe(cancelled.order.id);
    expect(cancel.saved.cart.status).toBe('submitted');
  });

  it('keeps an order the restaurant is still working on', async () => {
    const { conversation } = await leftOpen('ready', 2);
    ai({ actions: addTwo, response: { text: 'Anything else?', askFor: 'anything_else' } });
    const { saved } = await message(conversation, '2 chicken biryani');
    expect(saved.cart.status).toBe('submitted');
    expect(prompt()).toContain('"status":"submitted"');
  });
});
