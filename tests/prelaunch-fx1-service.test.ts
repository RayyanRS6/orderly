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

const { generate } = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: generate,
  Output: { object: vi.fn() },
}));

const company = seedCompanies[0]!;
const products = seedProducts.filter((p) => p.companyId === company.id);
const biryani = products.find((p) => p.name === 'Chicken Biryani')!;
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
  ai({
    actions: [{ type: 'answer', text: '' }],
    response: { text: 'Delivery usually takes about 40 minutes.', askFor: 'none' },
  });
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
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

let phoneCounter = 0;
const saved = async (c: Conversation) => (await repo.getConversation(company.id, c.id))!;
async function message(conversation: Conversation, text: string) {
  const current = (await repo.getConversation(company.id, conversation.id)) ?? conversation;
  const result = await handleTurn(repo, configured, current, {
    messageId: randomUUID(),
    text,
    now: new Date().toISOString(),
  });
  return { result, saved: await saved(conversation) };
}
async function placedOrder(status: Order['status'] = 'pending', updatedAt?: string) {
  let c: Conversation = {
    ...createConversation(
      company.id,
      `9230055${String(++phoneCounter).padStart(5, '0')}`,
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
  const placed = step({ type: 'confirm' });
  c.version = 1;
  await repo.commitTurn(company.id, c, 0, placed.order);
  if (status !== 'pending' || updatedAt)
    await repo.saveOrder({ ...placed.order!, status, ...(updatedAt && { updatedAt }) });
  return {
    conversation: await saved(c),
    order: (await repo.getOrder(company.id, placed.order!.id))!,
  };
}

describe('F36: “order cancel karein” cancels a waiting order', () => {
  it.each(['order cancel karein', 'cancel karen', 'mera order cancel kr den'])(
    'cancels on “%s” without the AI',
    async (text) => {
      const { conversation, order } = await placedOrder();
      const { result, saved: after } = await message(conversation, text);
      expect(result.order?.status).toBe('cancelled');
      expect((await repo.getOrder(company.id, order.id))!.status).toBe('cancelled');
      expect(after.mode).toBe('bot');
      expect(generate).not.toHaveBeenCalled();
    },
  );
});

describe('A returning customer’s “how long” question is not answered with an old order', () => {
  it('asks the AI about a fresh cart when the last order finished days ago', async () => {
    const old = new Date(Date.now() - 3 * 24 * 3600000).toISOString();
    const { conversation, order } = await placedOrder('completed', old);
    const { result, saved: after } = await message(
      conversation,
      'kitni der mein delivery hoti hai?',
    );
    expect(result.traces).not.toContain('order_status');
    expect(result.reply).toContain('Delivery usually takes about 40 minutes.');
    expect(result.reply).not.toContain(order.reference);
    expect(generate).toHaveBeenCalledOnce();
    expect(after.cart.status).toBe('building');
  });

  it('still answers “kitni der?” about an order in progress without the AI', async () => {
    const { conversation, order } = await placedOrder('accepted');
    const { result } = await message(conversation, 'kitni der?');
    expect(result.traces).toContain('order_status');
    expect(result.reply).toContain(`The restaurant has accepted order ${order.reference}.`);
    expect(generate).not.toHaveBeenCalled();
  });
});
