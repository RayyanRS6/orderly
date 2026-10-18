// The in-memory store (local demo and tests) gives the same answers as the SQL in
// prelaunch-h-sql.test.ts: the Active orders filter.
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MemoryRepository } from '../server/repository';
import { createConversation, processTurn } from '../src/domain/engine';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import type { BotAction, OrderStatus } from '../src/shared/types';

const company = seedCompanies[0]!;
const products = seedProducts.filter((p) => p.companyId === company.id);
const now = () => new Date().toISOString();
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60000).toISOString();
let repo: MemoryRepository;
let phones = 0;
const nextPhone = () => `+9230055${String(++phones).padStart(5, '0')}`;

beforeEach(async () => {
  repo = new MemoryRepository(false);
  await repo.saveCompany({ ...company, botEnabled: true });
  await repo.replaceProducts(company.id, products);
});
async function placedOrder(change: { status?: OrderStatus; createdAt?: string } = {}) {
  let c = createConversation(company.id, nextPhone(), 'whatsapp', minutesAgo(30));
  const turn = (action: BotAction) => {
    const result = processTurn(company, products, c, {
      messageId: randomUUID(),
      text: action.type === 'confirm' ? 'confirm' : 'test',
      action,
      now: now(),
    });
    c = result.conversation;
    return result;
  };
  turn({ type: 'add_item', productId: products[0]!.id, quantity: 2 });
  turn({ type: 'set_details', customerName: 'Test Customer', fulfillment: 'pickup' });
  turn({ type: 'review' });
  const { conversation, order } = turn({ type: 'confirm' });
  conversation.version = 1;
  expect(await repo.commitTurn(company.id, conversation, 0, order)).toBe(true);
  await repo.saveOrder({ ...order!, ...change });
  return order!;
}

describe('the Active orders filter, in memory', () => {
  it('holds the orders being worked on, and pending orders only under Pending', async () => {
    const statuses: OrderStatus[] = [
      'pending',
      'accepted',
      'preparing',
      'ready',
      'out_for_delivery',
      'completed',
      'rejected',
      'cancelled',
    ];
    const ids: Record<string, string> = {};
    for (const status of statuses) ids[status] = (await placedOrder({ status })).id;
    const list = (status: string) => repo.queryOrders(company.id, { status, sandbox: false });
    const active = await list('active');
    expect(active.total).toBe(4);
    expect(active.items.map((o) => o.status).sort()).toEqual([
      'accepted',
      'out_for_delivery',
      'preparing',
      'ready',
    ]);
    for (const status of ['pending', 'completed', 'rejected', 'cancelled'])
      expect((await list(status)).items.map((o) => o.id)).toEqual([ids[status]]);
    expect((await list('all')).total).toBe(statuses.length);
  });
});
