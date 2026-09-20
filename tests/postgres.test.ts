import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import { createConversation, processTurn } from '../src/domain/engine';
import { makeJob } from '../server/jobs';
import type { BotAction, Conversation, Order } from '../src/shared/types';
import { defaultBot } from '../src/shared/bot';

const db = new PGlite();
const company = seedCompanies[0];
const other = seedCompanies[1];
const products = seedProducts.filter((p) => p.companyId === company.id);
const ownerId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const outsiderId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const now = () => new Date().toISOString();
async function scalar(sql: string, args: unknown[] = []) {
  return (await db.query<{ value: unknown }>(sql, args)).rows[0]?.value;
}
async function rpc(name: string, args: unknown[]) {
  return scalar(
    `select public.${name}(${args.map((_, i) => `$${i + 1}`).join(',')}) as value`,
    args,
  );
}
function pendingOrder(channel: Conversation['channel'] = 'whatsapp') {
  let conversation = createConversation(company.id, '+923000000099', channel, now());
  const turn = (action: BotAction) => {
    const result = processTurn(company, products, conversation, {
      messageId: randomUUID(),
      text: action.type === 'confirm' ? 'confirm' : 'test',
      action,
      now: now(),
    });
    conversation = result.conversation;
    return result;
  };
  turn({ type: 'add_item', productId: products[0].id, quantity: 2 });
  turn({ type: 'set_details', customerName: 'Test Customer', fulfillment: 'pickup' });
  turn({ type: 'review' });
  const result = turn({ type: 'confirm' });
  if (!result.order) throw new Error(result.reply);
  result.conversation.version = 1;
  return { conversation: result.conversation, order: result.order };
}
async function commit(
  conversation: Conversation,
  order?: Order,
  jobs: unknown[] = [],
  version = 0,
) {
  return rpc('commit_turn', [company.id, conversation, version, order ?? null, jobs, null]);
}

beforeAll(async () => {
  await db.exec(
    `create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz); create table auth.mfa_factors(id uuid primary key,user_id uuid,status text); create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{"aal":"aal1"}') $$; create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; grant usage on schema auth to authenticated,service_role; grant execute on function auth.uid() to authenticated,service_role;`,
  );
  for (const migration of [
    '202609090001_initial.sql',
    '202609090002_order_transitions.sql',
    '202609160001_launch_hardening.sql',
    '202609160002_message_delivery.sql',
    '202609170001_retention.sql',
    '202609170003_staff_attention.sql',
    '202609180001_email_alerts.sql',
    '202609180003_platform_budget.sql',
    '202609200001_whatsapp_gateway.sql',
  ])
    await db.exec(readFileSync(`supabase/migrations/${migration}`, 'utf8'));
  await db.query('insert into auth.users(id) values($1),($2)', [ownerId, outsiderId]);
}, 30000);
beforeEach(async () => {
  await db.exec(
    'reset role; update auth.users set email=null,email_confirmed_at=null; update platform_limits set monthly_budget_usd=100',
  );
  await db.exec(
    "reset role; truncate public.companies cascade; delete from public.platform_admins; delete from auth.mfa_factors; select set_config('request.jwt.claims','',false);",
  );
  for (const c of seedCompanies)
    await db.query('insert into companies(id,slug,data) values($1,$2,$3)', [c.id, c.slug, c]);
  for (const p of seedProducts)
    await db.query('insert into products(id,company_id,data) values($1,$2,$3)', [
      p.id,
      p.companyId,
      p,
    ]);
});
afterAll(async () => {
  await db.close();
});

describe('opt-in retention and staff attention', () => {
  it('isolates native identities and connection generations in PostgreSQL, with server-only connection writes', async () => {
    const id = randomUUID();
    const connection = {
      id,
      companyId: company.id,
      provider: 'baileys',
      generation: 1,
      revision: 1,
      status: 'connected',
      accountJid: '923000000000@s.whatsapp.net',
      updatedAt: now(),
    };
    expect(await rpc('save_whatsapp_connection', [connection, 0])).toBe(true);
    expect(await rpc('save_whatsapp_connection', [{ ...connection, revision: 2 }, 0])).toBe(false);
    const first = {
      ...createConversation(company.id, '', 'whatsapp', now()),
      whatsappAddress: {
        connectionId: id,
        generation: 1,
        provider: 'baileys',
        peer: '100000001@lid',
      },
      version: 1,
    };
    const second = {
      ...first,
      id: randomUUID(),
      whatsappAddress: { ...first.whatsappAddress, peer: '100000002@lid' },
    };
    expect(await rpc('save_conversation', [first, 0])).toBe(true);
    expect(await rpc('save_conversation', [second, 0])).toBe(true);
    await expect(
      rpc('save_conversation', [
        { ...first, version: 2, whatsappAddress: { ...first.whatsappAddress, generation: 2 } },
        1,
      ]),
    ).rejects.toThrow('Cannot change conversation transport');
    const a = makeJob(company.id, 'incoming', { phone: '', streamKey: 'native-a' });
    const b = makeJob(company.id, 'incoming', { phone: '', streamKey: 'native-b' });
    await rpc('insert_job', [a, null]);
    await rpc('insert_job', [b, null]);
    expect((await rpc('list_due_jobs', [10])) as unknown[]).toHaveLength(2);
    const nonce = randomUUID();
    expect(await rpc('consume_gateway_nonce', [nonce])).toBe(true);
    expect(await rpc('consume_gateway_nonce', [nonce])).toBe(false);
    await db.exec('set role authenticated');
    await expect(
      rpc('save_whatsapp_connection', [{ ...connection, revision: 2 }, 1]),
    ).rejects.toThrow('permission denied');
    await expect(db.query('select * from whatsapp_connections')).rejects.toThrow(
      'permission denied',
    );
  });
  it('enforces a shared platform allowance while keeping client-funded spending separate', async () => {
    await rpc('configure_platform_budget', [5]);
    const expiry = new Date(Date.now() + 60000).toISOString();
    expect(await rpc('reserve_budget', [company.id, 'platform-a', 4, expiry])).toBe(true);
    expect(await rpc('reserve_budget', [company.id, 'platform-b', 2, expiry])).toBe(false);
    expect(await rpc('reserve_budget', [other.id, 'own-key', 4, expiry])).toBe(true);
    await rpc('settle_budget', [
      'own-key',
      { id: 'own-key', companyId: other.id, costUsd: 3, createdAt: now() },
    ]);
    expect(await rpc('platform_budget', [])).toMatchObject({
      limitUsd: 5,
      reservedUsd: 4,
      spentUsd: 0,
    });
    await db.query(
      "update companies set data=jsonb_set(data,'{ai,keyMode}','\"own\"') where id=$1",
      [company.id],
    );
    await rpc('settle_budget', [
      'platform-a',
      { id: 'platform-a', companyId: company.id, costUsd: 2, createdAt: now() },
    ]);
    expect(await rpc('platform_budget', [])).toMatchObject({ reservedUsd: 0, spentUsd: 2 });
    expect(
      await scalar("select data->>'funding' value from usage_events where id='platform-a'"),
    ).toBe('platform');
  });
  it('queues email only for a subscribed verified member with overdue work and throttles reminders', async () => {
    await db.query("insert into company_memberships values($1,$2,'staff')", [company.id, ownerId]);
    await expect(rpc('configure_alerts', [company.id, ownerId, true, 10])).rejects.toThrow(
      'Verified',
    );
    await db.query(
      "update auth.users set email='staff@example.test',email_confirmed_at=now() where id=$1",
      [ownerId],
    );
    expect(await rpc('configure_alerts', [company.id, ownerId, true, 10])).toMatchObject({
      enabled: true,
      emailVerified: true,
    });
    await expect(rpc('configure_alerts', [other.id, ownerId, true, 10])).rejects.toThrow(
      'Membership',
    );
    expect(await rpc('queue_staff_alerts', [])).toBe(0);
    const { conversation, order } = pendingOrder();
    await commit(conversation, order);
    await db.query("update orders set created_at=now()-interval '20 minutes' where id=$1", [
      order.id,
    ]);
    expect(await rpc('queue_staff_alerts', [])).toBe(1);
    expect(await rpc('queue_staff_alerts', [])).toBe(0);
    expect(await rpc('alert_recipient', [company.id, ownerId])).toBe('staff@example.test');
    expect(
      await scalar("select count(*)::int value from jobs where data->>'kind'='staff_alert'"),
    ).toBe(1);
    await db.query('delete from company_memberships where company_id=$1 and user_id=$2', [
      company.id,
      ownerId,
    ]);
    expect(await rpc('alert_recipient', [company.id, ownerId])).toBeNull();
  });
  it('shows budget warnings at 80 percent including unsettled usage holds', async () => {
    const budget = company.ai.monthlyBudgetUsd;
    expect(await rpc('company_budget_warning', [company.id])).toBe(false);
    await rpc('reserve_budget', [
      company.id,
      'held-budget',
      budget * 0.81,
      new Date(Date.now() + 60000).toISOString(),
    ]);
    expect(await rpc('company_budget_warning', [company.id])).toBe(true);
    expect(await rpc('staff_attention', [company.id])).toMatchObject({ budgets: 1, total: 1 });
    expect(await rpc('has_overdue_attention', [company.id, 10])).toBe(true);
    expect(await rpc('staff_attention', [other.id])).toMatchObject({ budgets: 0 });
  });
  async function oldConversation(withOrder = false) {
    const pair = pendingOrder();
    await commit(pair.conversation, withOrder ? pair.order : undefined);
    await db.query(
      "update conversations set updated_at=now()-interval '120 days',data=data||jsonb_build_object('updatedAt',now()-interval '120 days','lastInboundAt',now()-interval '120 days') where id=$1",
      [pair.conversation.id],
    );
    return pair;
  }
  async function activate() {
    await rpc('configure_retention', [company.id, 30, ownerId]);
    await db.query(
      "update retention_policies set eligible_after=now()-interval '1 minute' where company_id=$1",
      [company.id],
    );
  }
  it('starts disabled, previews without deleting, and enforces a 24-hour grace period', async () => {
    await oldConversation();
    expect(await rpc('retention_status', [company.id, 30])).toMatchObject({
      days: 0,
      eligibleConversations: 1,
    });
    expect(await rpc('run_retention', [company.id])).toBe(0);
    const policy = (await rpc('configure_retention', [company.id, 30, ownerId])) as {
      eligibleAfter: string;
    };
    expect(Date.parse(policy.eligibleAfter) - Date.now()).toBeGreaterThan(86300000);
    expect(await rpc('run_retention', [company.id])).toBe(0);
    await expect(rpc('configure_retention', [company.id, 1, ownerId])).rejects.toThrow(
      'Invalid retention',
    );
    await activate();
    await rpc('configure_retention', [company.id, 0, ownerId]);
    expect(await rpc('run_retention', [company.id])).toBe(0);
  });
  it('protects unfinished orders, recent completed orders, handoffs, incoming jobs and processing locks', async () => {
    const { conversation, order } = await oldConversation(true);
    await activate();
    expect(await rpc('run_retention', [company.id])).toBe(0);
    await db.query(
      "update orders set data=jsonb_set(data,'{status}','\"completed\"') where id=$1",
      [order.id],
    );
    expect(await rpc('run_retention', [company.id])).toBe(0);
    await db.query(
      "update orders set updated_at=now()-interval '120 days',created_at=now()-interval '120 days' where id=$1",
      [order.id],
    );
    await db.query(
      "update conversations set data=jsonb_set(data,'{mode}','\"human\"') where id=$1",
      [conversation.id],
    );
    expect(await rpc('run_retention', [company.id])).toBe(0);
    await db.query("update conversations set data=jsonb_set(data,'{mode}','\"bot\"') where id=$1", [
      conversation.id,
    ]);
    const job = makeJob(company.id, 'incoming', { phone: conversation.customerPhone });
    await rpc('insert_job', [job]);
    expect(await rpc('run_retention', [company.id])).toBe(0);
    await db.query(
      "update jobs set status='done',data=jsonb_set(data,'{status}','\"done\"') where id=$1",
      [job.id],
    );
    await rpc('acquire_conversation_lock', [
      company.id,
      conversation.id,
      'worker',
      new Date(Date.now() + 60000).toISOString(),
    ]);
    expect(await rpc('run_retention', [company.id])).toBe(0);
    await rpc('release_conversation_lock', [company.id, conversation.id, 'worker']);
    expect(await rpc('run_retention', [company.id])).toBe(1);
    expect(await scalar('select count(*)::int value from orders where id=$1', [order.id])).toBe(0);
  });
  it('removes history and receipts, preserves dedupe tombstones, and respects workspace boundaries', async () => {
    const { conversation } = await oldConversation();
    const otherConvo = createConversation(
      other.id,
      conversation.customerPhone,
      'whatsapp',
      new Date(Date.now() - 120 * 86400000).toISOString(),
    );
    otherConvo.version = 1;
    await rpc('commit_turn', [other.id, otherConvo, 0, null, [], null]);
    const job = {
      ...makeJob(company.id, 'incoming', {
        phone: conversation.customerPhone,
        text: 'private text',
      }),
      status: 'done',
      error: 'private error',
    };
    await rpc('insert_job', [job]);
    await rpc('record_delivery', [company.id, 'receipt', 'sent', conversation.id, 'm', null]);
    await activate();
    expect(await rpc('run_retention_batch', [])).toBe(1);
    expect(
      await scalar('select count(*)::int value from conversations where company_id=$1', [other.id]),
    ).toBe(1);
    expect(
      await scalar('select count(*)::int value from conversation_messages where company_id=$1', [
        company.id,
      ]),
    ).toBe(0);
    expect(
      await scalar('select count(*)::int value from message_deliveries where company_id=$1', [
        company.id,
      ]),
    ).toBe(0);
    const tombstone = await scalar('select data value from jobs where id=$1', [job.id]);
    expect(tombstone).toMatchObject({ status: 'done', payload: {} });
    expect(tombstone).not.toHaveProperty('error');
    expect(await rpc('retention_status', [company.id, 30])).toMatchObject({
      lastDeleted: 1,
      eligibleConversations: 0,
    });
  });
  it('never deletes recently active conversations and bounds each batch', async () => {
    const { conversation } = await oldConversation();
    await activate();
    await db.query(
      "update conversations set data=jsonb_set(data,'{lastInboundAt}',to_jsonb(now())) where id=$1",
      [conversation.id],
    );
    expect(await rpc('run_retention', [company.id])).toBe(0);
    for (let i = 0; i < 103; i++) {
      const c = createConversation(
        company.id,
        `batch-${i}`,
        'demo',
        new Date(Date.now() - 120 * 86400000).toISOString(),
      );
      c.version = 1;
      await rpc('commit_turn', [company.id, c, 0, null, [], null]);
    }
    expect(await rpc('retention_status', [company.id, 30])).toMatchObject({
      eligibleConversations: 100,
    });
    expect(await rpc('run_retention', [company.id])).toBe(100);
    expect(await rpc('run_retention', [company.id])).toBe(3);
  });
  it('reports tenant-scoped live alerts and clears resolved work', async () => {
    const { conversation, order } = pendingOrder();
    await commit(conversation, order);
    await db.query(
      "update conversations set data=jsonb_set(data,'{mode}','\"human\"') where id=$1",
      [conversation.id],
    );
    const failed = {
      ...makeJob(company.id, 'sheet_sync', { orderId: order.id }),
      status: 'failed',
    };
    await rpc('insert_job', [failed]);
    const alerts = await rpc('staff_attention', [company.id]);
    expect(alerts).toMatchObject({ total: 3, orders: 1, handoffs: 1, failures: 1 });
    expect(JSON.stringify(alerts)).not.toContain(conversation.customerPhone);
    expect(await rpc('staff_attention', [other.id])).toMatchObject({ total: 0, items: [] });
    await db.query(
      "update orders set data=jsonb_set(data,'{status}','\"cancelled\"') where id=$1",
      [order.id],
    );
    await db.query("update conversations set data=jsonb_set(data,'{mode}','\"bot\"') where id=$1", [
      conversation.id,
    ]);
    await db.query(
      "update jobs set status='pending',data=jsonb_set(data,'{status}','\"pending\"') where id=$1",
      [failed.id],
    );
    expect(await rpc('staff_attention', [company.id])).toMatchObject({ total: 0 });
  });
  it('denies browser roles direct access to policies and operations RPCs', async () => {
    await db.exec('set role authenticated');
    await expect(rpc('configure_retention', [company.id, 30, ownerId])).rejects.toThrow(
      'permission denied',
    );
    await expect(rpc('run_retention', [company.id])).rejects.toThrow('permission denied');
    await expect(rpc('staff_attention', [company.id])).rejects.toThrow('permission denied');
    await expect(rpc('configure_alerts', [company.id, ownerId, true, 10])).rejects.toThrow(
      'permission denied',
    );
    await expect(rpc('alert_recipient', [company.id, ownerId])).rejects.toThrow(
      'permission denied',
    );
    await expect(rpc('configure_platform_budget', [500])).rejects.toThrow('permission denied');
    await expect(db.query('select * from retention_policies')).rejects.toThrow('permission denied');
  });
});

describe('launch migration safeguards', () => {
  it('merges out-of-order delivery receipts and scopes them to the business', async () => {
    const { conversation, order } = pendingOrder();
    await commit(conversation, order);
    await rpc('record_delivery', [company.id, 'wamid-test', 'read', null, null, null]);
    await rpc('record_delivery', [
      company.id,
      'wamid-test',
      'accepted',
      conversation.id,
      'local-message',
      null,
    ]);
    expect(
      await scalar('select status as value from message_deliveries where company_id=$1', [
        company.id,
      ]),
    ).toBe('read');
    expect(
      await scalar('select message_id as value from message_deliveries where company_id=$1', [
        company.id,
      ]),
    ).toBe('local-message');
    await expect(
      rpc('record_delivery', [
        other.id,
        'wamid-test',
        'sent',
        conversation.id,
        'wrong-tenant',
        null,
      ]),
    ).rejects.toThrow('foreign key');
    await db.exec('set role authenticated');
    await expect(db.exec('select * from message_deliveries')).rejects.toThrow('permission denied');
  });
  it('archives complete message history while bounding the active conversation', async () => {
    const c = createConversation(company.id, '923000009999', 'demo', now());
    c.version = 1;
    c.messages = Array.from({ length: 125 }, (_, i) => ({
      id: `message-${String(i).padStart(3, '0')}`,
      role: 'customer' as const,
      text: `Message ${i}`,
      createdAt: new Date(Date.now() + i).toISOString(),
    }));
    expect(await rpc('save_conversation', [c, 0])).toBe(true);
    expect(
      await scalar(
        "select jsonb_array_length(data->'messages') as value from conversations where id=$1",
        [c.id],
      ),
    ).toBe(100);
    const history = (await rpc('conversation_history', [company.id, c.id, 2])) as {
      items: unknown[];
      total: number;
    };
    expect(history.total).toBe(125);
    expect(history.items).toHaveLength(25);
    expect(
      ((await rpc('conversation_history', [other.id, c.id, 1])) as { total: number }).total,
    ).toBe(0);
    const list = (await rpc('query_conversations', [company.id, { pageSize: 10 }])) as {
      items: Conversation[];
    };
    expect(list.items[0].messages).toHaveLength(1);
  });
  it('allows sandbox orders while paused and keeps real orders paused', async () => {
    const { conversation, order } = pendingOrder('demo');
    await db.query("update companies set data=jsonb_set(data,'{botEnabled}','false') where id=$1", [
      company.id,
    ]);
    expect(await commit(conversation, order)).toBe(true);
    const next = {
      ...conversation,
      version: 2,
      cart: { ...conversation.cart, status: 'cancelled' },
    };
    expect(
      await rpc('update_order_status', [
        company.id,
        order.id,
        'pending',
        'cancelled',
        now(),
        [],
        next,
        1,
      ]),
    ).toMatchObject({ status: 'cancelled' });
  });
  it('enforces phone confirmation in the transaction, including a direct status update', async () => {
    const { conversation, order } = pendingOrder();
    order.phoneConfirmationRequired = true;
    await commit(conversation, order);
    await expect(
      rpc('update_order_status', [company.id, order.id, 'pending', 'accepted', now(), []]),
    ).rejects.toThrow('Record phone');
    expect(
      await rpc('record_call', [
        other.id,
        order.id,
        { outcome: 'confirmed', addressVerified: true, at: now(), actorId: ownerId, note: '' },
      ]),
    ).toBeNull();
    await rpc('record_call', [
      company.id,
      order.id,
      { outcome: 'confirmed', addressVerified: true, at: now(), actorId: ownerId, note: '' },
    ]);
    expect(
      await rpc('update_order_status', [company.id, order.id, 'pending', 'accepted', now(), []]),
    ).toMatchObject({ status: 'accepted' });
  });
  it('guards draft revisions and preserves them during unrelated company saves', async () => {
    const bot = { draft: defaultBot, revision: 1, history: [] };
    expect(await rpc('save_bot', [company.id, bot, 0])).toBe(true);
    expect(await rpc('save_bot', [company.id, bot, 0])).toBe(false);
    await rpc('save_company_settings', [{ ...company, name: 'Renamed' }]);
    expect(
      await scalar("select data->'bot'->>'revision' as value from companies where id=$1", [
        company.id,
      ]),
    ).toBe('1');
    expect(await rpc('save_bot', [other.id, { ...bot, revision: 3 }, 2])).toBe(false);
  });
  it('returns exact live and sandbox totals with paginated filters', async () => {
    const { conversation, order } = pendingOrder();
    await commit(conversation, order);
    expect(
      await rpc('query_orders', [company.id, { pageSize: 1, sandbox: false, search: 'Test' }]),
    ).toMatchObject({ total: 1, page: 1, pageSize: 1 });
    expect(await rpc('query_orders', [company.id, { sandbox: true }])).toMatchObject({ total: 0 });
    expect(await rpc('workspace_summary', [company.id, false])).toMatchObject({
      orders: 1,
      pending: 1,
      value: order.total,
    });
    expect(await rpc('query_orders', [other.id, {}])).toMatchObject({ total: 0 });
  });
  it('deletes customer data and keeps a payload-free webhook dedupe tombstone', async () => {
    const { conversation, order } = pendingOrder();
    await commit(conversation, order);
    const job = makeJob(company.id, 'incoming', {
      phone: conversation.customerPhone,
      messageId: 'pii-test',
      text: 'private customer text',
    });
    job.error = 'Provider error containing private customer text';
    await rpc('insert_job', [job, 'dedupe-erased']);
    await expect(rpc('erase_customer', [company.id, conversation.customerPhone])).rejects.toThrow(
      'Pause automation',
    );
    await db.query("update companies set data=jsonb_set(data,'{botEnabled}','false') where id=$1", [
      company.id,
    ]);
    expect(await rpc('erase_customer', [company.id, conversation.customerPhone])).toBe(1);
    expect(await scalar('select count(*)::int as value from conversation_messages')).toBe(0);
    expect(await scalar('select count(*)::int as value from orders')).toBe(0);
    expect(await scalar("select data->'payload' as value from jobs where id=$1", [job.id])).toEqual(
      {},
    );
    expect(
      await scalar("select data->'error' as value from jobs where id=$1", [job.id]),
    ).toBeNull();
    expect(await rpc('insert_job', [{ ...job, id: randomUUID() }, 'dedupe-erased'])).toBe(false);
  });
  it('enforces opt-in MFA on direct database reads', async () => {
    await db.query("insert into company_memberships values($1,$2,'owner')", [company.id, ownerId]);
    await db.query("insert into auth.mfa_factors values($1,$2,'verified')", [
      randomUUID(),
      ownerId,
    ]);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [ownerId]);
    await db.exec('set role authenticated');
    expect(await scalar('select count(*)::int as value from companies')).toBe(0);
    await db.query("select set_config('request.jwt.claims',$1,false)", [
      JSON.stringify({ aal: 'aal2' }),
    ]);
    expect(await scalar('select count(*)::int as value from companies')).toBe(1);
    await expect(
      rpc('save_bot', [company.id, { draft: defaultBot, revision: 1, history: [] }, 0]),
    ).rejects.toThrow('permission denied');
  });
  it('keeps at least one owner and denies browser audit mutations', async () => {
    await db.query("insert into company_memberships values($1,$2,'owner')", [company.id, ownerId]);
    await expect(rpc('manage_member', [company.id, ownerId, null, outsiderId])).rejects.toThrow(
      'Keep another owner',
    );
    await rpc('audit_event', [company.id, ownerId, 'bot.published']);
    await db.exec('set role service_role');
    await expect(db.exec('delete from audit_events')).rejects.toThrow('permission denied');
  });
});

describe('real Postgres migrations and transactional invariants', () => {
  it('commits a confirmed order and outbox atomically, rejects a stale replay', async () => {
    const { conversation, order } = pendingOrder();
    const job = makeJob(company.id, 'sheet_sync', { orderId: order.id });
    expect(await commit(conversation, order, [job])).toBe(true);
    expect(await commit(conversation, order, [job])).toBe(false);
    expect(await scalar('select count(*)::int as value from orders')).toBe(1);
    expect(await scalar('select count(*)::int as value from jobs')).toBe(1);
  });
  it('rolls back the conversation and order when a cross-company job is submitted', async () => {
    const { conversation, order } = pendingOrder();
    await expect(commit(conversation, order, [makeJob(other.id, 'incoming', {})])).rejects.toThrow(
      'Cross-company job',
    );
    expect(await scalar('select count(*)::int as value from conversations')).toBe(0);
    expect(await scalar('select count(*)::int as value from orders')).toBe(0);
  });
  it('rechecks current catalog prices inside the transaction', async () => {
    const { conversation, order } = pendingOrder();
    await db.query(`update products set data=jsonb_set(data,'{price}','99000') where id=$1`, [
      products[0].id,
    ]);
    await expect(commit(conversation, order)).rejects.toThrow('Catalog price changed');
    expect(await scalar('select count(*)::int as value from conversations')).toBe(0);
  });
  it('rejects a sold-out item even when a quote was made earlier', async () => {
    const { conversation, order } = pendingOrder();
    await db.query(`update products set data=jsonb_set(data,'{available}','false') where id=$1`, [
      products[0].id,
    ]);
    await expect(commit(conversation, order)).rejects.toThrow('item unavailable');
  });
  it('does not insert an order after automatic ordering was paused', async () => {
    const { conversation, order } = pendingOrder();
    await db.query(`update companies set data=jsonb_set(data,'{botEnabled}','false') where id=$1`, [
      company.id,
    ]);
    await expect(commit(conversation, order)).rejects.toThrow('ordering is paused');
    expect(await scalar('select count(*)::int as value from orders')).toBe(0);
    expect(await scalar('select count(*)::int as value from conversations')).toBe(0);
  });
  it('cannot move an existing product between tenants', async () => {
    const p = { ...products[0], companyId: other.id };
    await expect(
      db.query('update products set company_id=$1,data=$2 where id=$3', [other.id, p, p.id]),
    ).rejects.toThrow('Cross-company reassignment');
  });
  it('only one competing accept/cancel status change can win', async () => {
    const { conversation, order } = pendingOrder();
    await commit(conversation, order);
    expect(
      await rpc('update_order_status', [company.id, order.id, 'pending', 'accepted', now(), []]),
    ).toMatchObject({ status: 'accepted' });
    expect(
      await rpc('update_order_status', [company.id, order.id, 'pending', 'cancelled', now(), []]),
    ).toBeNull();
    expect(
      await rpc('update_order_status', [other.id, order.id, 'accepted', 'preparing', now(), []]),
    ).toBeNull();
    await expect(
      rpc('update_order_status', [company.id, order.id, 'accepted', 'completed', now(), []]),
    ).rejects.toThrow('Invalid order status');
  });
  it('a stale spreadsheet completion cannot mark a newer order update synced', async () => {
    const { conversation, order } = pendingOrder();
    await commit(conversation, order);
    const later = new Date(Date.parse(order.updatedAt) + 1000).toISOString();
    await rpc('update_order_status', [company.id, order.id, 'pending', 'accepted', later, []]);
    await rpc('set_order_sync_status', [company.id, order.id, 'pending', null]);
    await rpc('set_order_sync_status', [company.id, order.id, 'synced', order.updatedAt]);
    expect(
      await scalar(`select data->>'syncStatus' as value from orders where id=$1`, [order.id]),
    ).toBe('pending');
    await rpc('set_order_sync_status', [company.id, order.id, 'synced', later]);
    expect(
      await scalar(`select data->>'status' as value from orders where id=$1`, [order.id]),
    ).toBe('accepted');
  });
  it('commits automatic cancellation, conversation, and sync state in one transaction', async () => {
    const { conversation, order } = pendingOrder();
    await commit(conversation, order);
    const next = {
      ...conversation,
      version: 2,
      cart: { ...conversation.cart, status: 'cancelled' },
    };
    const job = makeJob(company.id, 'sheet_sync', { orderId: order.id });
    expect(
      await rpc('update_order_status', [
        company.id,
        order.id,
        'pending',
        'cancelled',
        now(),
        [job],
        next,
        1,
      ]),
    ).toMatchObject({ status: 'cancelled', syncStatus: 'pending' });
    expect(
      await scalar('select version as value from conversations where id=$1', [conversation.id]),
    ).toBe(2);
    expect(await scalar('select count(*)::int as value from jobs')).toBe(1);
  });
  it.each(['human', 'disabled', 'stale'])(
    'rejects an automatic cancellation with %s state',
    async (reason) => {
      const { conversation, order } = pendingOrder();
      await commit(conversation, order);
      const next = {
        ...conversation,
        version: 2,
        cart: { ...conversation.cart, status: 'cancelled' },
      };
      if (reason === 'disabled')
        await db.query(
          `update companies set data=jsonb_set(data,'{botEnabled}','false') where id=$1`,
          [company.id],
        );
      else
        await rpc('save_conversation', [
          { ...conversation, version: 2, mode: reason === 'human' ? 'human' : 'bot' },
          1,
        ]);
      expect(
        await rpc('update_order_status', [
          company.id,
          order.id,
          'pending',
          'cancelled',
          now(),
          [],
          next,
          1,
        ]),
      ).toBeNull();
      expect(
        await scalar(`select data->>'status' as value from orders where id=$1`, [order.id]),
      ).toBe('pending');
    },
  );
  it('rolls back a cancellation and conversation if its delivery job is invalid', async () => {
    const { conversation, order } = pendingOrder();
    await commit(conversation, order);
    const next = {
      ...conversation,
      version: 2,
      cart: { ...conversation.cart, status: 'cancelled' },
    };
    await expect(
      rpc('update_order_status', [
        company.id,
        order.id,
        'pending',
        'cancelled',
        now(),
        [makeJob(other.id, 'incoming', {})],
        next,
        1,
      ]),
    ).rejects.toThrow('Cross-company job');
    expect(
      await scalar('select version as value from conversations where id=$1', [conversation.id]),
    ).toBe(1);
    expect(
      await scalar(`select data->>'status' as value from orders where id=$1`, [order.id]),
    ).toBe('pending');
    expect(await scalar('select count(*)::int as value from jobs')).toBe(0);
  });
  it('deduplicates webhook jobs and grants only one worker lease', async () => {
    const job = makeJob(company.id, 'incoming', {});
    expect(await rpc('insert_job', [job, 'wamid-1'])).toBe(true);
    expect(await rpc('insert_job', [{ ...job, id: randomUUID() }, 'wamid-1'])).toBe(false);
    const timestamp = now();
    const lease = new Date(Date.now() + 60000).toISOString();
    expect(await rpc('claim_job', [job.id, timestamp, lease])).toMatchObject({
      attempts: 1,
      status: 'processing',
    });
    expect(await rpc('claim_job', [job.id, timestamp, lease])).toBeNull();
  });
  it('preserves incoming arrival order across retries, failed jobs and staff recovery', async () => {
    const edit = makeJob(company.id, 'incoming', {
      phone: '923001111111',
      text: 'change quantity',
    });
    const confirm = makeJob(company.id, 'incoming', { phone: '923001111111', text: 'confirm' });
    confirm.createdAt = new Date(Date.parse(edit.createdAt) - 1000).toISOString();
    await rpc('insert_job', [edit]);
    await rpc('insert_job', [confirm]);
    const lease = new Date(Date.now() + 60000).toISOString();
    expect(await rpc('claim_job', [confirm.id, now(), lease])).toBeNull();
    expect(await rpc('list_due_jobs', [1])).toMatchObject([{ id: edit.id }]);
    expect(await rpc('claim_job', [edit.id, now(), lease])).toMatchObject({
      id: edit.id,
      attempts: 1,
    });
    expect(await rpc('claim_job', [confirm.id, now(), lease])).toBeNull();
    await db.query(
      `update jobs set status='pending',next_run_at=now()+interval '1 hour',data=data||'{"status":"pending"}' where id=$1`,
      [edit.id],
    );
    expect(await rpc('list_due_jobs', [100])).toEqual([]);
    expect(await rpc('claim_job', [confirm.id, now(), lease])).toBeNull();
    await db.query(`update jobs set status='failed',data=data||'{"status":"failed"}' where id=$1`, [
      edit.id,
    ]);
    expect(await rpc('list_due_jobs', [100])).toEqual([]);
    expect(await rpc('retry_failed_jobs', [company.id])).toBe(1);
    expect(await rpc('claim_job', [confirm.id, now(), lease])).toBeNull();
    expect(await rpc('claim_job', [edit.id, now(), lease])).toMatchObject({
      id: edit.id,
      attempts: 1,
    });
    await db.query(`update jobs set status='done',data=data||'{"status":"done"}' where id=$1`, [
      edit.id,
    ]);
    expect(await rpc('claim_job', [confirm.id, now(), lease])).toMatchObject({ id: confirm.id });
  });
  it('keeps unrelated customers and companies processing behind a failed incoming stream', async () => {
    const failed = {
      ...makeJob(company.id, 'incoming', { phone: 'same-phone' }),
      status: 'failed',
    };
    const blocked = makeJob(company.id, 'incoming', { phone: 'same-phone' });
    const anotherCustomer = makeJob(company.id, 'incoming', { phone: 'another-phone' });
    const anotherCompany = makeJob(other.id, 'incoming', { phone: 'same-phone' });
    for (const job of [failed, blocked, anotherCustomer, anotherCompany])
      await rpc('insert_job', [job]);
    expect(await rpc('list_due_jobs', [1])).toMatchObject([{ id: anotherCustomer.id }]);
    expect(await rpc('list_due_jobs', [100])).toMatchObject([
      { id: anotherCustomer.id },
      { id: anotherCompany.id },
    ]);
    const lease = new Date(Date.now() + 60000).toISOString();
    expect(await rpc('claim_job', [anotherCompany.id, now(), lease])).toMatchObject({
      id: anotherCompany.id,
    });
  });
  it('locks a new conversation before it exists and respects lease ownership', async () => {
    const lease = new Date(Date.now() + 60000).toISOString();
    expect(
      await rpc('acquire_conversation_lock', [company.id, 'new-phone', 'worker-1', lease]),
    ).toBe(true);
    expect(
      await rpc('acquire_conversation_lock', [company.id, 'new-phone', 'worker-2', lease]),
    ).toBe(false);
    await rpc('release_conversation_lock', [company.id, 'new-phone', 'worker-2']);
    expect(
      await rpc('acquire_conversation_lock', [company.id, 'new-phone', 'worker-2', lease]),
    ).toBe(false);
  });
  it('reserves budget atomically and settles usage once', async () => {
    const expiry = new Date(Date.now() + 60000).toISOString();
    const budget = company.ai.monthlyBudgetUsd;
    expect(await rpc('reserve_budget', [company.id, 'a', budget - 1, expiry])).toBe(true);
    expect(await rpc('reserve_budget', [company.id, 'b', 2, expiry])).toBe(false);
    const usage = {
      id: 'a',
      companyId: company.id,
      provider: 'openai',
      model: 'gpt-5.4-mini',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0.01,
      createdAt: now(),
    };
    await rpc('settle_budget', ['a', usage]);
    await rpc('settle_budget', ['a', usage]);
    expect(await scalar('select count(*)::int as value from usage_events')).toBe(1);
    expect(await rpc('reserve_budget', [company.id, 'b', 2, expiry])).toBe(true);
  });
  it('retains an expired budget hold when a crashed worker cannot report actual usage', async () => {
    await rpc('reserve_budget', [
      company.id,
      'interrupted',
      company.ai.monthlyBudgetUsd,
      new Date(Date.now() + 60000).toISOString(),
    ]);
    await db.exec("update budget_reservations set expires_at=now()-interval '1 minute'");
    expect(
      await rpc('reserve_budget', [
        company.id,
        'another-call',
        0.01,
        new Date(Date.now() + 60000).toISOString(),
      ]),
    ).toBe(false);
  });
  it('RLS exposes only the member’s company; browser writes and secret reads are denied', async () => {
    await db.query(`insert into company_memberships values($1,$2,'staff')`, [company.id, ownerId]);
    await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [ownerId]);
    await db.exec('set role authenticated');
    expect(await scalar('select count(*)::int as value from companies')).toBe(1);
    expect(await scalar('select count(*)::int as value from products')).toBe(products.length);
    await expect(db.exec('select * from integration_secrets')).rejects.toThrow('permission denied');
    await expect(db.exec('delete from products')).rejects.toThrow('permission denied');
    await expect(rpc('replace_products', [company.id, []])).rejects.toThrow('permission denied');
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [outsiderId]);
    await db.exec('set role authenticated');
    expect(await scalar('select count(*)::int as value from companies')).toBe(0);
  });
  it('allows a founder to read all companies without exposing secret tables', async () => {
    await db.query('insert into platform_admins values($1)', [ownerId]);
    await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [ownerId]);
    await db.exec('set role authenticated');
    expect(await scalar('select count(*)::int as value from companies')).toBe(2);
    await expect(db.exec('select * from integration_secrets')).rejects.toThrow('permission denied');
  });
});
