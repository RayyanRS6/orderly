// Final review, fx-6 (conversation-5, F35), through handleTurn with a (mocked) AI: an order staff
// never closed does not block the AI's new order, and keeps the status staff gave it.
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
// A chat whose order staff moved to `status` `hoursAgo` hours ago and never closed.
async function leftOpen(status: Order['status'], hoursAgo: number) {
  let c: Conversation = {
    ...createConversation(
      company.id,
      `9230066${String(++phones).padStart(5, '0')}`,
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
  const updatedAt = new Date(Date.now() - hoursAgo * 3600000).toISOString();
  await repo.saveOrder({ ...placed.order!, status, updatedAt });
  return { conversation: c, order: placed.order! };
}
const addTwo: ModelInterpretation = {
  actions: [{ type: 'add_item', productId: biryani.id, quantity: 2 }],
  response: { text: 'Anything else?', askFor: 'anything_else' },
};

describe('F35: the AI’s new order after an order staff never closed', () => {
  it('starts a fresh cart and leaves the old order’s status alone', async () => {
    const { conversation, order } = await leftOpen('ready', 14);
    ai(addTwo);
    const { result, saved } = await message(conversation, '2 chicken biryani');
    expect(saved.cart).toMatchObject({ status: 'building', items: [{ quantity: 2 }] });
    expect(saved.cart.orderId).toBeUndefined();
    expect(saved.cart.revision).toBeGreaterThan(conversation.cart.revision);
    expect(result.traces).not.toContain('duplicate_submission_prevented');
    expect(result.reply).toContain('Added 2 × Chicken Biryani');
    expect((await repo.getOrder(company.id, order.id))!.status).toBe('ready');
  });

  it('keeps an order the restaurant is still working on', async () => {
    const { conversation } = await leftOpen('preparing', 2);
    ai(addTwo);
    const { result, saved } = await message(conversation, '2 chicken biryani');
    expect(saved.cart.status).toBe('submitted');
    expect(result.reply).toContain('already been submitted');
  });
});
