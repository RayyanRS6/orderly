// The Orders page's Active filter and the Overview's daily counts by the business's own days
// (F93), in 202610200001_prelaunch_fixes.sql on the whole migration chain.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createConversation, processTurn } from '../src/domain/engine';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import type {
  BotAction,
  Order,
  OrderStatus,
  PageResult,
  WorkspaceSummary,
} from '../src/shared/types';
import { migratedDb } from './helpers/migrated-db';

const company = seedCompanies[0]!;
const products = seedProducts.filter((p) => p.companyId === company.id);
const now = () => new Date().toISOString();
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60000).toISOString();
let t: Awaited<ReturnType<typeof migratedDb>>;
const scalar = <T = unknown>(text: string, args: unknown[] = []) => t.scalar<T>(text, args);
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

describe('the Overview counts orders by the business’s own days (F93)', () => {
  const zoneOf = async (timezone: unknown) => {
    await t.db.query(
      "update companies set data=case when $2::jsonb is null then data-'timezone' else jsonb_set(data,'{timezone}',$2::jsonb) end where id=$1",
      [company.id, timezone === undefined ? null : JSON.stringify(timezone)],
    );
  };
  // A date near today where the business is, and the moment a clock there shows `time` on it.
  const day = (zone: string, daysAgo = 0) =>
    scalar<string>('select ((now() at time zone $1)::date-$2::int)::text as value', [
      zone,
      daysAgo,
    ]);
  const moment = (zone: string, daysAgo: number, time: string) =>
    scalar<string>(
      `select to_char(((((now() at time zone $1)::date-$2::int)+$3::time) at time zone $1) at time zone 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as value`,
      [zone, daysAgo, time],
    );
  const summary = () => rpc<WorkspaceSummary>('workspace_summary', [company.id, false]);
  const counted = (s: WorkspaceSummary) => s.daily.filter((d) => d.count);

  it('puts an order after midnight in Karachi on that day, not the UTC day before', async () => {
    const zone = 'Asia/Karachi';
    expect(company.timezone).toBe(zone);
    const placed = [
      // 00:30 today in Karachi is 19:30 yesterday in UTC.
      [0, '00:30'],
      [1, '23:30'],
      // The first day shown; the day before it is no longer in the chart.
      [29, '00:10'],
      [30, '23:50'],
    ] as const;
    for (const [daysAgo, time] of placed)
      await setOrder((await placedOrder()).id, { createdAt: await moment(zone, daysAgo, time) });

    const result = await summary();
    expect(result).toMatchObject({ orders: 4, pending: 4 });
    expect(result.daily).toHaveLength(30);
    expect(result.daily.at(-1)).toEqual({ date: await day(zone), count: 1 });
    expect(result.daily[0]).toEqual({ date: await day(zone, 29), count: 1 });
    expect(counted(result)).toEqual([
      { date: await day(zone, 29), count: 1 },
      { date: await day(zone, 1), count: 1 },
      { date: await day(zone), count: 1 },
    ]);
    // One day after another, whatever the database's own zone.
    for (const [i, d] of result.daily.entries())
      expect(Date.parse(d.date)).toBe(Date.parse(result.daily[0]!.date) + i * 86400000);
    await t.db.exec("set timezone to 'America/Los_Angeles'");
    expect(await summary()).toEqual(result);
  });

  it('uses the business’s own time zone when it is elsewhere', async () => {
    const zone = 'America/Bogota';
    await zoneOf(zone);
    // 23:30 yesterday in Bogota is already today in UTC and in Karachi.
    await setOrder((await placedOrder()).id, { createdAt: await moment(zone, 1, '23:30') });
    const result = await summary();
    expect(result.daily.at(-1)).toEqual({ date: await day(zone), count: 0 });
    expect(counted(result)).toEqual([{ date: await day(zone, 1), count: 1 }]);
  });

  it('counts Karachi days for a missing, offset or unknown time zone, and never fails', async () => {
    await setOrder((await placedOrder()).id, {
      createdAt: await moment('Asia/Karachi', 0, '00:30'),
    });
    const karachi = await summary();
    expect(counted(karachi)).toEqual([{ date: await day('Asia/Karachi'), count: 1 }]);
    // Postgres would read '+05:00' and 'UTC+5' as 5 hours west of UTC.
    const others = [
      undefined,
      '',
      '+05:00',
      'UTC+5',
      'PKT',
      'Not/A_Zone',
      "Asia/Karachi'; drop table orders; --",
      42,
    ];
    for (const timezone of others) {
      await zoneOf(timezone);
      expect(await summary(), String(timezone)).toEqual(karachi);
      expect(await rpc('business_time_zone', [{ timezone }]), String(timezone)).toBe(
        'Asia/Karachi',
      );
    }
    for (const zone of ['Asia/Karachi', 'UTC', 'America/Bogota', 'Europe/London', 'Etc/GMT-5'])
      expect(await rpc('business_time_zone', [{ timezone: zone }])).toBe(zone);
    expect(await rpc('business_time_zone', [null])).toBe('Asia/Karachi');
  });
});
