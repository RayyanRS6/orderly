// The worker reads "how long" questions about a placed order as the engine does: about an order
// still in progress (or finished minutes ago) they get its real status with no AI call, and an
// order that finished hours ago does not take over a returning customer's question.
// Local store, mocked AI SDK, no network.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MemoryRepository } from '../server/repository';
import { encryptSecret } from '../server/security';
import { handleTurn } from '../server/service';
import { modelFingerprint } from '../server/integrations/model-catalog';
import { createConversation, processTurn } from '../src/domain/engine';
import { defaultBot } from '../src/shared/bot';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import type { BotAction, Company, Conversation, Order } from '../src/shared/types';

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
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60000).toISOString();
let repo: MemoryRepository;
let configured: Company;

beforeEach(async () => {
  generate.mockReset();
  generate.mockResolvedValue({
    output: {
      actions: [{ type: 'answer', text: '' }],
      response: { text: 'Delivery usually takes about 40 minutes.', askFor: 'none' },
    },
    usage: { inputTokens: 1000, outputTokens: 50 },
  });
  repo = new MemoryRepository();
  vi.stubEnv('APP_MODE', 'demo');
  vi.stubEnv('ORDERLY_RUNTIME', '');
  vi.stubEnv('VERCEL', '');
  vi.stubEnv('APP_URL', 'http://127.0.0.1:5173');
  vi.stubEnv('MODEL_PRICING_JSON', '');
  vi.stubEnv('ORDERLY_PAUSE_AUTOMATION', '');
  vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('Unexpected network request'))),
  );
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
    modelVerification: { fingerprint: modelFingerprint(base, key), checkedAt: minutesAgo(0) },
  };
  await repo.saveCompany(configured);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

let phones = 0;
const saved = async (c: Conversation) => (await repo.getConversation(company.id, c.id))!;
// A WhatsApp order placed through the engine, then given this status and last change.
async function orderNow(status: Order['status'], updatedMinutesAgo: number) {
  let c: Conversation = {
    ...createConversation(
      company.id,
      `9230066${String(++phones).padStart(5, '0')}`,
      'whatsapp',
      '1970-01-01T00:00:00.000Z',
    ),
    version: 0,
  };
  let order: Order | undefined;
  for (const action of [
    { type: 'add_item', productId: biryani.id, quantity: 1 },
    { type: 'set_details', customerName: 'Ali Raza', fulfillment: 'pickup' },
    { type: 'review' },
    { type: 'confirm' },
  ] as BotAction[]) {
    const result = processTurn(configured, products, c, {
      messageId: randomUUID(),
      text: action.type === 'confirm' ? 'confirm' : 'step',
      action,
      now: minutesAgo(updatedMinutesAgo + 5),
    });
    c = result.conversation;
    order = result.order ?? order;
  }
  c.version = 1;
  expect(await repo.commitTurn(company.id, c, 0, order)).toBe(true);
  await repo.saveOrder({ ...order!, status, updatedAt: minutesAgo(updatedMinutesAgo) });
  return { conversation: await saved(c), order: order! };
}
async function message(conversation: Conversation, text: string) {
  const result = await handleTurn(repo, configured, await saved(conversation), {
    messageId: randomUUID(),
    text,
    now: new Date().toISOString(),
  });
  return { result, after: await saved(conversation) };
}

describe('“how long” questions are read as the engine reads them', () => {
  it.each(['how long does delivery take?', 'kitni der mein delivery hoti hai?'])(
    'answers “%s” about an order still in progress without the AI',
    async (text) => {
      const { conversation, order } = await orderNow('pending', 10);
      const { result } = await message(conversation, text);
      expect(result.traces).toContain('order_status');
      expect(result.reply).toContain(`Order ${order.reference} is waiting for the restaurant`);
      expect(generate).not.toHaveBeenCalled();
      expect(result.explanation?.ai).toMatchObject({ called: false });
    },
  );

  it('answers it about an order that finished minutes ago, keeping that order', async () => {
    const { conversation, order } = await orderNow('rejected', 30);
    const { result, after } = await message(conversation, 'kitni der mein delivery hoti hai?');
    expect(result.reply).toContain(`The restaurant could not accept order ${order.reference}.`);
    expect(generate).not.toHaveBeenCalled();
    expect(after.cart).toMatchObject({ status: 'submitted', orderId: order.id });
  });

  it('leaves an order that finished hours ago alone: a fresh cart and the AI answer', async () => {
    const { conversation, order } = await orderNow('completed', 3 * 60);
    const { result, after } = await message(conversation, 'how long does delivery take?');
    expect(result.traces).not.toContain('order_status');
    expect(result.reply).toContain('Delivery usually takes about 40 minutes.');
    expect(result.reply).not.toContain(order.reference);
    expect(generate).toHaveBeenCalledOnce();
    expect(after.cart.status).toBe('building');
  });

  it('still answers a question that names the order, whatever its age, without the AI', async () => {
    const { conversation, order } = await orderNow('completed', 3 * 24 * 60);
    const { result } = await message(conversation, 'where is my order?');
    expect(result.reply).toContain(`Order ${order.reference} is completed.`);
    expect(generate).not.toHaveBeenCalled();
  });
});
