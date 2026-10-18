// The API on a fresh seeded local store in local demo mode, for each test, with no network.
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../server/app';
import { MemoryRepository } from '../../server/repository';
import { createConversation, processTurn } from '../../src/domain/engine';
import { seedCompanies, seedProducts } from '../../src/shared/seed';
import type { WhatsAppConnection } from '../../src/shared/whatsapp';
import type { BotAction, Conversation, Order } from '../../src/shared/types';

export const company = seedCompanies[0]!;
const products = seedProducts.filter((p) => p.companyId === company.id);
export const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60000).toISOString();

export function demoApp() {
  let repo = new MemoryRepository();
  beforeEach(() => {
    repo = new MemoryRepository();
    vi.stubEnv('APP_MODE', 'demo');
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('ORDERLY_RUNTIME', '');
    vi.stubEnv('APP_URL', 'http://127.0.0.1:5173');
    vi.stubEnv('MODEL_PRICING_JSON', '');
    vi.stubEnv('HEALTH_CHECK_TOKEN', '');
    vi.stubEnv('ORDERLY_PAUSE_AUTOMATION', '');
    vi.stubEnv('WORKER_LEASE_SECONDS', '');
    vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('Unexpected network request'))),
    );
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  return {
    repo: () => repo,
    request(
      path: string,
      options: { body?: unknown; method?: string; headers?: Record<string, string> } = {},
    ) {
      return createApp(repo).request(`http://127.0.0.1:4000/api${path}`, {
        method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
        headers: {
          'Content-Type': 'application/json',
          'x-company-id': company.id,
          Origin: 'http://127.0.0.1:5173',
          ...options.headers,
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    },
  };
}

// A WhatsApp order waiting for the restaurant, placed through the engine.
export async function placedOrder(
  repo: MemoryRepository,
  phone = '+923001110001',
): Promise<{ order: Order; chat: Conversation }> {
  let chat: Conversation = createConversation(company.id, phone, 'whatsapp', minutesAgo(5));
  const step = (action: BotAction) =>
    processTurn(company, products, chat, {
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
    chat = step(action).conversation;
  const placed = step({ type: 'confirm' });
  const saved = { ...placed.conversation, version: 1 };
  expect(await repo.commitTurn(company.id, saved, 0, placed.order)).toBe(true);
  return { order: placed.order!, chat: saved };
}

export const linkedPhone = (fields: Partial<WhatsAppConnection> = {}): WhatsAppConnection => ({
  id: '5f0c9a59-3c1e-4c55-9c7c-2f3d1a4b5c6d',
  companyId: company.id,
  provider: 'baileys',
  generation: 1,
  revision: 1,
  status: 'connected',
  accountJid: '923001234567@s.whatsapp.net',
  lastHeartbeatAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...fields,
});

// Replaces the business's stored connection with a linked phone with these fields.
export async function storeConnection(
  repo: MemoryRepository,
  fields: Partial<WhatsAppConnection> & { downSince?: string },
) {
  const current = await repo.getWhatsAppConnection(company.id);
  const revision = (current?.revision ?? 0) + 1;
  const next = { ...linkedPhone(fields), revision };
  expect(await repo.saveWhatsAppConnection(next, revision - 1)).toBe(true);
  return next;
}
