// The Orders page's Active filter, the Overview's daily counts by the business's own days (F93)
// and how long a customer has waited for staff (G5.1), in 202610200001_prelaunch_fixes.sql on the
// whole migration chain.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createConversation, processTurn } from '../src/domain/engine';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import type {
  BotAction,
  Conversation,
  Message,
  Order,
  OrderStatus,
  PageResult,
  StaffAttention,
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

describe('a customer waiting for staff has waited since their message (G5.1)', () => {
  const message = (
    role: Message['role'],
    text: string,
    createdAt: string,
    extra: Partial<Message> = {},
  ): Message => ({ id: randomUUID(), role, text, createdAt, ...extra });
  // A chat with staff, saved when its last message was written (or `updatedAt`).
  async function waiting(messages: Message[], updatedAt = messages.at(-1)?.createdAt ?? now()) {
    const c: Conversation = {
      ...createConversation(company.id, nextPhone(), 'whatsapp', updatedAt),
      mode: 'human',
      messages,
      updatedAt,
      version: 1,
    };
    expect(await rpc('save_conversation', [c, 0])).toBe(true);
    return c;
  }
  // A staff message now, the chat saved again with it.
  async function staffWrites(c: Conversation, text: string, extra: Partial<Message> = {}) {
    const next = {
      ...c,
      version: c.version + 1,
      updatedAt: now(),
      messages: [...c.messages, message('staff', text, now(), extra)],
    };
    expect(await rpc('save_conversation', [next, c.version])).toBe(true);
    return next;
  }
  // As the order status route adds its notice.
  const notice = (c: Conversation, text: string) => staffWrites(c, text, { notice: true });
  const overdue = (minutes: number) => rpc<boolean>('has_overdue_attention', [company.id, minutes]);
  const since = async (c: Conversation) => {
    const item = (await rpc<StaffAttention>('staff_attention', [company.id])).items.find(
      (a) => a.id === `handoff:${c.id}`,
    );
    return item && Date.parse(item.createdAt);
  };

  it('keeps counting through order status notices, so the email alert is not held back', async () => {
    const user = randomUUID();
    await t.db.query(
      "insert into auth.users(id,email,email_confirmed_at) values($1,'staff@example.test',now())",
      [user],
    );
    await t.db.query("insert into company_memberships values($1,$2,'owner')", [company.id, user]);
    await rpc('configure_alerts', [company.id, user, true, 10]);
    const asked = minutesAgo(12);
    let c = await waiting([
      message('customer', 'Is my order coming?', asked),
      // The bot's own reply as it handed the chat to staff is not a staff reply.
      message('assistant', 'A staff member will reply here shortly.', asked),
    ]);
    expect(await since(c)).toBe(Date.parse(asked));
    expect(await overdue(10)).toBe(true);
    c = await notice(c, 'Order ORD-1 is now preparing.');
    c = await notice(c, 'Order ORD-1 is now ready.');
    // Saved before notices were marked.
    c = await staffWrites(c, 'Order ORD-1 is now out for delivery.');
    // Each notice saved the chat again.
    expect(
      await scalar(
        "select updated_at>now()-interval '1 minute' as value from conversations where id=$1",
        [c.id],
      ),
    ).toBe(true);
    expect(await since(c)).toBe(Date.parse(asked));
    expect(await overdue(10)).toBe(true);
    expect(await overdue(15)).toBe(false);
    expect(await rpc('queue_staff_alerts')).toBe(1);
  });

  it('counts from the customer’s latest message, until a staff member replies', async () => {
    const c = await waiting([
      message('customer', 'Hello', minutesAgo(40)),
      message('customer', 'Anyone there?', minutesAgo(5)),
    ]);
    expect(await since(c)).toBe(Date.parse(c.messages[1]!.createdAt));
    expect(await overdue(10)).toBe(false);
    const answered = await staffWrites(c, 'Calling you now');
    expect(await since(answered)).toBeUndefined();
    expect(await overdue(1)).toBe(false);
  });

  it('counts from when the chat was saved when no customer message is waiting', async () => {
    const saved = minutesAgo(20);
    const chats = [
      // The bot handed over without the customer writing since a staff reply.
      await waiting(
        [
          message('customer', 'Hi', minutesAgo(30)),
          message('staff', 'Hello, how can I help?', minutesAgo(25)),
          message('assistant', 'I have asked a staff member to help.', saved),
        ],
        saved,
      ),
      await waiting([], saved),
      // Dated after the chat was saved (a phone clock running fast).
      await waiting([message('customer', 'Hi', minutesAgo(-10))], saved),
    ];
    for (const c of chats) expect(await since(c)).toBe(Date.parse(saved));
    expect(await overdue(15)).toBe(true);
    expect(await overdue(30)).toBe(false);
  });

  it.each(['anon', 'authenticated'])('is for the server only, never %s', async (role) => {
    for (const signature of [
      'public.waiting_since(jsonb,timestamp with time zone,timestamp with time zone)',
      'public.business_time_zone(jsonb)',
      'public.query_orders(text,jsonb)',
      'public.workspace_summary(text,boolean)',
      'public.staff_attention(text)',
      'public.has_overdue_attention(text,integer)',
    ]) {
      expect(
        await scalar(`select has_function_privilege($1,$2,'EXECUTE') as value`, [role, signature]),
        signature,
      ).toBe(false);
      expect(
        await scalar(`select has_function_privilege('service_role',$1,'EXECUTE') as value`, [
          signature,
        ]),
        signature,
      ).toBe(true);
    }
  });
});
