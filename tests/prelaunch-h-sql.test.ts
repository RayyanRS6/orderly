// The Orders page's Active filter, in 202610200001_prelaunch_fixes.sql on the whole migration
// chain.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createConversation, processTurn } from '../src/domain/engine';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import type { BotAction, Order, OrderStatus, PageResult } from '../src/shared/types';
import { migratedDb } from './helpers/migrated-db';

const company = seedCompanies[0]!;
const products = seedProducts.filter((p) => p.companyId === company.id);
const now = () => new Date().toISOString();
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60000).toISOString();
let t: Awaited<ReturnType<typeof migratedDb>>;
const rpc = <T = unknown>(name: string, args: unknown[] = []) => t.rpc<T>(name, args);
let phones = 0;
const nextPhone = () => `+9230044${String(++phones).padStart(5, '0')}`;
beforeAll(async () => {
  t = await migratedDb();
}, 30000);
beforeEach(async () => {
  await t.reset();
  // As on Supabase. PGlite otherwise takes the computer's zone.
  await t.db.exec("set timezone to 'UTC'");
});
afterAll(() => t.db.close());

async function placedOrder() {
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
  const result = turn({ type: 'confirm' });
  result.conversation.version = 1;
  expect(
    await rpc('commit_turn', [company.id, result.conversation, 0, result.order, [], null]),
  ).toBe(true);
  return result.order!;
}
const setOrder = (id: string, fields: { status?: OrderStatus; createdAt?: string }) =>
  t.db.query(
    `update orders set data=data||jsonb_strip_nulls(jsonb_build_object('status',$2::text,'createdAt',$3::text)),
       created_at=coalesce($3::timestamptz,created_at) where id=$1`,
    [id, fields.status ?? null, fields.createdAt ?? null],
  );

describe('the Active orders filter (UI audit)', () => {
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
  const list = (status: string) =>
    rpc<PageResult<Order>>('query_orders', [company.id, { status, sandbox: false }]);

  it('holds the orders being worked on, and pending orders only under Pending', async () => {
    const ids: Record<string, string> = {};
    for (const status of statuses) {
      const order = await placedOrder();
      await setOrder(order.id, { status });
      ids[status] = order.id;
    }
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
