// Fix package 7, database timing, on the whole migration chain: a customer who keeps writing
// becomes overdue (sql-3), a message held in order is not "stalled" (sql-4) and the reminder for
// an order not yet accepted skips orders placed hours ago (sql-5).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createConversation, processTurn } from '../src/domain/engine';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import type { PipelineHealth } from '../server/repository';
import type {
  BotAction,
  Conversation,
  Job,
  Message,
  StaffAttention,
  TurnExplanation,
} from '../src/shared/types';
import { migratedDb } from './helpers/migrated-db';

const company = seedCompanies[0]!;
const products = seedProducts.filter((p) => p.companyId === company.id);
const now = () => new Date().toISOString();
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60000).toISOString();
const workerUrl = 'https://abcdefghijklmnopqrst.supabase.co/functions/v1/orderly/api/jobs/process';
const workerToken = 'test-worker-token-for-prelaunch-checks-123456';
let t: Awaited<ReturnType<typeof migratedDb>>;
const rpc = <T = unknown>(name: string, args: unknown[] = []) => t.rpc<T>(name, args);
beforeAll(async () => {
  t = await migratedDb();
}, 30000);
beforeEach(async () => {
  await t.reset();
  await t.db.exec("set timezone to 'UTC'");
});
afterAll(() => t.db.close());

describe('sql-3: a customer who keeps writing becomes overdue', () => {
  const message = (
    role: Message['role'],
    text: string,
    createdAt: string,
    extra: Partial<Message> = {},
  ): Message => ({ id: randomUUID(), role, text, createdAt, ...extra });
  const handedOver = { outcome: 'staff' } as TurnExplanation;
  let phones = 0;
  async function waiting(messages: Message[], extra: Partial<Conversation> = {}) {
    const updatedAt = messages.at(-1)?.createdAt ?? now();
    const c: Conversation = {
      ...createConversation(
        company.id,
        `+9230077${String(++phones).padStart(5, '0')}`,
        'whatsapp',
        updatedAt,
      ),
      mode: 'human',
      messages,
      updatedAt,
      ...extra,
      version: 1,
    };
    expect(await rpc('save_conversation', [c, 0])).toBe(true);
    return c;
  }
  const since = async (c: Conversation) => {
    const item = (await rpc<StaffAttention>('staff_attention', [company.id])).items.find(
      (a) => a.id === `handoff:${c.id}`,
    );
    return item && Date.parse(item.createdAt);
  };
  const overdue = (minutes: number) => rpc<boolean>('has_overdue_attention', [company.id, minutes]);

  it('counts from the first of several messages, so asking again every 8 minutes is overdue', async () => {
    const c = await waiting(
      [40, 32, 24, 16, 8].map((m) => message('customer', 'hello?', minutesAgo(m))),
    );
    expect(await since(c)).toBe(Date.parse(c.messages[0]!.createdAt));
    expect(await overdue(10)).toBe(true);
    expect(await overdue(45)).toBe(false);
  });

  it('counts from the message the bot handed over, not from those it answered before', async () => {
    const asked = minutesAgo(30);
    const answered = [
      message('customer', 'menu', minutesAgo(60)),
      message('assistant', 'Here is our menu.', minutesAgo(60)),
      message('customer', 'I want to speak to someone', asked),
    ];
    const plain = await waiting([
      ...answered,
      message('assistant', 'A staff member will reply here shortly.', asked),
    ]);
    expect(await since(plain)).toBe(Date.parse(asked));
    // Its explanation says it handed over: asking again does not move the clock.
    const nudged = await waiting([
      ...answered,
      message('assistant', 'A staff member will reply here shortly.', asked, {
        explanation: handedOver,
      }),
      message('customer', 'hello?', minutesAgo(20)),
      message('customer', 'hello??', minutesAgo(10)),
    ]);
    expect(await since(nudged)).toBe(Date.parse(asked));
  });

  it('counts from the first message after the bot’s last answer, and after a staff reply', async () => {
    // The bot answered, then was paused: the next message waits.
    const paused = await waiting([
      message('customer', 'menu', minutesAgo(60)),
      message('assistant', 'Here is our menu.', minutesAgo(60)),
      message('customer', 'one biryani', minutesAgo(20)),
      message('customer', 'hello?', minutesAgo(5)),
    ]);
    expect(await since(paused)).toBe(Date.parse(paused.messages[2]!.createdAt));
    const replied = await waiting([
      message('customer', 'Is it ready?', minutesAgo(60)),
      message('staff', 'Five minutes.', minutesAgo(50)),
      message('staff', 'Order ORD-1 is now ready.', minutesAgo(45), { notice: true }),
      message('customer', 'Still waiting', minutesAgo(30)),
      message('customer', 'Hello?', minutesAgo(10)),
    ]);
    expect(await since(replied)).toBe(Date.parse(replied.messages[3]!.createdAt));
  });

  it('after a takeover, counts from the first message written since', async () => {
    const takenOver = minutesAgo(25);
    const c = await waiting(
      [
        message('customer', 'menu', minutesAgo(60)),
        message('assistant', 'Here is our menu.', minutesAgo(60)),
        message('customer', 'hello?', minutesAgo(20)),
        message('customer', 'hello??', minutesAgo(10)),
      ],
      { humanSince: takenOver },
    );
    expect(await since(c)).toBe(Date.parse(c.messages[2]!.createdAt));
  });
});

describe('sql-4: a message held in order behind an earlier one is not stalled', () => {
  const health = () => rpc<PipelineHealth>('orderly_pipeline_health');
  async function job(
    id: string,
    { dueMinutesAgo = 5, attempts = 0 }: { dueMinutesAgo?: number; attempts?: number } = {},
  ) {
    const job: Job = {
      id,
      companyId: company.id,
      kind: 'incoming',
      payload: { phone: '', streamKey: 'stream-1' },
      status: 'pending',
      attempts,
      nextRunAt: minutesAgo(dueMinutesAgo),
      createdAt: minutesAgo(10),
    };
    expect(await rpc('insert_job', [job, null])).toBe(true);
  }
  beforeEach(() => rpc('configure_orderly_scheduler', [workerUrl, workerToken]));

  it('is ok while the earlier message waits to be retried or is being worked on', async () => {
    await job('retrying', { attempts: 3, dueMinutesAgo: -1 });
    await job('held', { dueMinutesAgo: 5 });
    expect(await health()).toMatchObject({ status: 'ok', stalledJobs: 0 });
    await t.db.exec(
      "update jobs set status='processing',attempts=4,lease_until=now()+interval '1 minute',data=data||jsonb_build_object('status','processing','attempts',4) where id='retrying'",
    );
    expect(await health()).toMatchObject({ status: 'ok', stalledJobs: 0 });
  });

  it('counts only the first of a customer’s messages when none is being sent', async () => {
    await job('head', { dueMinutesAgo: 6 });
    await job('held', { dueMinutesAgo: 5 });
    expect(await health()).toMatchObject({ status: 'stalled', stalledJobs: 1 });
    // A message already done holds nothing back.
    await t.db.exec(
      "update jobs set status='done',data=data||'{\"status\":\"done\"}'::jsonb where id='head'",
    );
    expect(await health()).toMatchObject({ status: 'stalled', stalledJobs: 1 });
  });
});

describe('sql-5: reminders only for orders placed within the last 3 hours', () => {
  let phones = 0;
  async function placedOrder() {
    const phone = `+9230066${String(++phones).padStart(5, '0')}`;
    let c = createConversation(company.id, phone, 'whatsapp', now());
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
    turn({ type: 'add_item', productId: products[0]!.id, quantity: 1 });
    turn({ type: 'set_details', customerName: 'Test Customer', fulfillment: 'pickup' });
    turn({ type: 'review' });
    const result = turn({ type: 'confirm' });
    result.conversation.version = 1;
    expect(
      await rpc('commit_turn', [company.id, result.conversation, 0, result.order, [], null]),
    ).toBe(true);
    return result.order!;
  }
  const age = (id: string, interval: string) =>
    t.db.query(`update orders set created_at=now()-interval '${interval}' where id=$1`, [id]);

  it('leaves out orders staff may have handled hours ago without pressing Accept', async () => {
    await rpc('configure_orderly_scheduler', [workerUrl, workerToken]);
    const orders = [];
    for (const interval of ['20 minutes', '170 minutes', '190 minutes', '23 hours']) {
      const order = await placedOrder();
      await age(order.id, interval);
      orders.push(order);
    }
    expect(await rpc('queue_order_followups')).toBe(2);
    const queued = (
      await t.db.query<{ id: string }>(
        "select data->'payload'->>'orderId' as id from jobs where data->>'kind'='order_followup'",
      )
    ).rows.map((r) => r.id);
    expect(queued.sort()).toEqual([orders[0]!.id, orders[1]!.id].sort());
  });
});
