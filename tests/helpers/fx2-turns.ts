// A fresh local store for each test, with no network, and helpers that send a customer's message
// through handleTurn or place an order through the engine (tests/prelaunch-fx2-*.test.ts).
import { afterEach, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MemoryRepository } from '../../server/repository';
import { handleTurn } from '../../server/service';
import { makeJob } from '../../server/jobs';
import { createConversation, processTurn } from '../../src/domain/engine';
import { seedCompanies, seedProducts } from '../../src/shared/seed';
import type { BotAction, Company, Conversation, Job, Order } from '../../src/shared/types';

export const company = seedCompanies[0]!;
export const products = seedProducts.filter((p) => p.companyId === company.id);

export function turnStore() {
  let repo = new MemoryRepository();
  beforeEach(() => {
    repo = new MemoryRepository();
    vi.stubEnv('APP_MODE', 'demo');
    vi.stubEnv('ORDERLY_RUNTIME', '');
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('MODEL_PRICING_JSON', '');
    vi.stubEnv('WORKER_LEASE_SECONDS', '');
    vi.stubEnv('ORDERLY_PAUSE_AUTOMATION', '');
    vi.stubEnv('MENU_LINK_SECRET', '');
    vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('Unexpected network request'))),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  let phones = 0;
  const chat = (changes: Partial<Conversation> = {}): Conversation => ({
    ...createConversation(
      company.id,
      `9230044${String(++phones).padStart(5, '0')}`,
      'whatsapp',
      '1970-01-01T00:00:00.000Z',
    ),
    ...changes,
  });
  // The customer's message, answered as the worker answers it.
  async function say(
    configured: Company,
    conversation: Conversation,
    text: string,
    extra: { now?: string; late?: boolean; action?: BotAction } = {},
  ) {
    const current = (await repo.getConversation(company.id, conversation.id)) ?? conversation;
    const result = await handleTurn(repo, configured, current, {
      messageId: randomUUID(),
      text,
      now: extra.now ?? new Date().toISOString(),
      ...(extra.late && { late: true }),
      ...(extra.action && { action: extra.action }),
    });
    return { result, saved: (await repo.getConversation(company.id, conversation.id))! };
  }
  // A WhatsApp order waiting for the restaurant, placed through the engine.
  async function waitingOrder(change: Partial<Conversation> = {}) {
    let c: Conversation = { ...chat(), version: 0 };
    const step = (action: BotAction) =>
      processTurn(company, products, c, {
        messageId: randomUUID(),
        text: action.type === 'confirm' ? 'confirm' : 'step',
        action,
        now: new Date().toISOString(),
      });
    for (const action of [
      { type: 'add_item', productId: products[0]!.id, quantity: 1 },
      { type: 'set_details', customerName: 'Ali Raza', fulfillment: 'pickup' },
      { type: 'review' },
    ] as BotAction[])
      c = step(action).conversation;
    const placed = step({ type: 'confirm' });
    const saved = { ...placed.conversation, ...change, version: 1 };
    await repo.commitTurn(company.id, saved, 0, placed.order);
    return { conversation: saved, order: placed.order! };
  }
  const followup = (order: Order): Job =>
    makeJob(company.id, 'order_followup', {
      orderId: order.id,
      conversationId: order.conversationId,
    });
  return { repo: () => repo, chat, say, waitingOrder, followup };
}
