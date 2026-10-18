// The in-memory store (local demo and tests) gives the same answers as the SQL in
// prelaunch-h-sql.test.ts: the Active orders filter and the Overview's daily counts by the
// business's own days (F93).
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MemoryRepository } from '../server/repository';
import { createConversation, processTurn } from '../src/domain/engine';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import type { BotAction, Company, OrderStatus, WorkspaceSummary } from '../src/shared/types';

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
async function settings(change: Partial<Company>) {
  await repo.saveCompany({ ...(await repo.getCompany(company.id))!, ...change });
}
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

describe('the Overview counts orders by the business’s own days, in memory (F93)', () => {
  // Zones without daylight saving, so their offsets are fixed.
  const offsets = { 'Asia/Karachi': 5, 'America/Bogota': -5 } as const;
  type Zone = keyof typeof offsets;
  const day = (zone: Zone, daysAgo = 0) =>
    new Date(Date.now() + offsets[zone] * 3600000 - daysAgo * 86400000).toISOString().slice(0, 10);
  // The moment a clock in `zone` shows `time` on that day.
  const moment = (zone: Zone, daysAgo: number, time: string) =>
    new Date(
      Date.parse(`${day(zone, daysAgo)}T${time}:00Z`) - offsets[zone] * 3600000,
    ).toISOString();
  const summary = () => repo.getSummary(company.id, false);
  const counted = (s: WorkspaceSummary) => s.daily.filter((d) => d.count);

  it('puts an order after midnight in Karachi on that day, not the UTC day before', async () => {
    const zone = 'Asia/Karachi';
    expect(company.timezone).toBe(zone);
    for (const [daysAgo, time] of [
      [0, '00:30'],
      [1, '23:30'],
      [29, '00:10'],
      [30, '23:50'],
    ] as const)
      await placedOrder({ createdAt: moment(zone, daysAgo, time) });
    const result = await summary();
    expect(result).toMatchObject({ orders: 4, pending: 4 });
    expect(result.daily).toHaveLength(30);
    expect(result.daily.at(-1)).toEqual({ date: day(zone), count: 1 });
    expect(counted(result)).toEqual([
      { date: day(zone, 29), count: 1 },
      { date: day(zone, 1), count: 1 },
      { date: day(zone), count: 1 },
    ]);
    for (const [i, d] of result.daily.entries())
      expect(Date.parse(d.date)).toBe(Date.parse(result.daily[0]!.date) + i * 86400000);
  });

  it('uses the business’s own time zone when it is elsewhere', async () => {
    const zone = 'America/Bogota';
    await settings({ timezone: zone });
    await placedOrder({ createdAt: moment(zone, 1, '23:30') });
    const result = await summary();
    expect(result.daily.at(-1)).toEqual({ date: day(zone), count: 0 });
    expect(counted(result)).toEqual([{ date: day(zone, 1), count: 1 }]);
  });

  it('counts Karachi days for a missing, offset or unknown time zone, and never fails', async () => {
    await placedOrder({ createdAt: moment('Asia/Karachi', 0, '00:30') });
    const karachi = await summary();
    expect(counted(karachi)).toEqual([{ date: day('Asia/Karachi'), count: 1 }]);
    for (const timezone of ['', '+05:00', 'UTC+5', 'PKT', 'Not/A_Zone', undefined]) {
      await settings({ timezone: timezone as string });
      expect(await summary(), String(timezone)).toEqual(karachi);
    }
  });
});
