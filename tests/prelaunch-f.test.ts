// Pre-launch database fixes (202610200001_prelaunch_fixes.sql, 202610200002_order_followups.sql),
// on the whole migration chain in PGlite with pg_cron, pg_net and Vault stubbed.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import { createConversation, processTurn } from '../src/domain/engine';
import { makeJob } from '../server/jobs';
import { AI_LIMIT_DEFAULTS } from '../src/shared/models';
import { blockCustomerArgs } from '../server/storage/supabase';
import type { PipelineHealth } from '../server/repository';
import type {
  BlockedCustomer,
  BotAction,
  Conversation,
  Job,
  Message,
  StaffAttention,
} from '../src/shared/types';

const db = new PGlite();
const company = seedCompanies[0]!;
const other = seedCompanies[1]!;
const products = seedProducts.filter((p) => p.companyId === company.id);
const files = readdirSync('supabase/migrations').sort();
// Migrations that record themselves in the ledger.
const recorded = files.filter((file) => file >= '202610200001');
const migration = (file: string) =>
  readFileSync(`supabase/migrations/${file}`, 'utf8').replace(/^create extension [^;]+;\r?$/gm, '');
const workerUrl = 'https://abcdefghijklmnopqrst.supabase.co/functions/v1/orderly/api/jobs/process';
const workerToken = 'test-worker-token-for-prelaunch-checks-123456';
const DENIED = /permission denied for (function|table)/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const now = () => new Date().toISOString();
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60000).toISOString();
const hourStart = () => Math.floor(Date.now() / 3600000) * 3600000;
const hourKey = () => new Date(hourStart()).toISOString().slice(0, 13);

async function scalar<T = unknown>(text: string, args: unknown[] = []) {
  return (await db.query<{ value: T }>(text, args)).rows[0]?.value as T;
}
async function rpc<T = unknown>(name: string, args: unknown[] = []) {
  return scalar<T>(
    `select public.${name}(${args.map((_, i) => `$${i + 1}`).join(',')}) as value`,
    args,
  );
}
const configure = () => rpc('configure_orderly_scheduler', [workerUrl, workerToken]);
const pause = (companyId = company.id) =>
  db.query("update companies set data=jsonb_set(data,'{botEnabled}','false') where id=$1", [
    companyId,
  ]);
let phones = 0;
const nextPhone = () => `+9230011${String(++phones).padStart(5, '0')}`;
async function chat(
  phone: string,
  extra: Partial<Conversation> = {},
  companyId = company.id,
  channel: Conversation['channel'] = 'whatsapp',
) {
  const c = { ...createConversation(companyId, phone, channel, now()), ...extra, version: 1 };
  expect(await rpc('save_conversation', [c, 0])).toBe(true);
  return c;
}
async function placedOrder(phone = nextPhone(), channel: Conversation['channel'] = 'whatsapp') {
  let conversation = createConversation(company.id, phone, channel, now());
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
  turn({ type: 'add_item', productId: products[0]!.id, quantity: 2 });
  turn({ type: 'set_details', customerName: 'Test Customer', fulfillment: 'pickup' });
  turn({ type: 'review' });
  const result = turn({ type: 'confirm' });
  if (!result.order) throw new Error(result.reply);
  result.conversation.version = 1;
  expect(
    await rpc('commit_turn', [company.id, result.conversation, 0, result.order, [], null]),
  ).toBe(true);
  return { conversation: result.conversation, order: result.order };
}
const ageOrder = (id: string, interval: string) =>
  db.query(`update orders set created_at=now()-interval '${interval}' where id=$1`, [id]);
const block = (conversationId: string, blockId: string, keys: string[], label = 'Spam sender') =>
  scalar(
    'select public.block_customer(p_company_id=>$1,p_conversation_id=>$2,p_block_id=>$3,p_keys=>$4,p_label=>$5,p_actor_id=>$6) as value',
    Object.values(blockCustomerArgs(company.id, conversationId, blockId, keys, label, 'owner')),
  );
const payloadOf = (id: string) =>
  scalar<Record<string, unknown>>("select data->'payload' as value from jobs where id=$1", [id]);
const attention = (companyId = company.id) => rpc<StaffAttention>('staff_attention', [companyId]);

beforeAll(async () => {
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz);
    create table auth.mfa_factors(id uuid primary key, user_id uuid, status text);
    create function auth.jwt() returns jsonb language sql stable as $$ select '{"aal":"aal1"}'::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
    grant usage on schema auth to authenticated, service_role;
    grant execute on function auth.uid() to authenticated, service_role;
    create schema vault;
    create table vault.secrets(id uuid primary key default gen_random_uuid(), name text unique, secret text);
    create view vault.decrypted_secrets as select id, name, secret as decrypted_secret from vault.secrets;
    create function vault.create_secret(new_secret text, new_name text default null, new_description text default '') returns uuid language sql as $$
      insert into vault.secrets(name,secret) values(new_name,new_secret) returning id;
    $$;
    create function vault.update_secret(secret_id uuid, new_secret text) returns void language sql as $$
      update vault.secrets set secret=new_secret where id=secret_id;
    $$;
    create schema net;
    create table net.http_request_queue(id bigserial primary key, url text, body jsonb, headers jsonb, timeout_milliseconds integer);
    create table net._http_response(id bigint, status_code integer, timed_out boolean, error_msg text, created timestamptz default now());
    create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds integer default 2000)
    returns bigint language sql as $$
      insert into net.http_request_queue(url,body,headers,timeout_milliseconds) values(url,body,headers,timeout_milliseconds) returning id;
    $$;
    create schema cron;
    create table cron.job(jobid bigserial primary key, jobname text unique, schedule text, command text, active boolean default true);
    create table cron.job_run_details(runid bigserial primary key, jobid bigint, status text, end_time timestamptz);
    create function cron.schedule(job_name text, job_schedule text, job_command text) returns bigint language sql as $$
      insert into cron.job(jobname,schedule,command) values(job_name,job_schedule,job_command)
        on conflict(jobname) do update set schedule=excluded.schedule,command=excluded.command returning jobid;
    $$;
  `);
  // A new installation: every file in filename order. None of the "superseded" guards fires.
  for (const file of files) await db.exec(migration(file));
}, 30000);
beforeEach(async () => {
  await db.exec(`reset role; truncate public.companies cascade; delete from public.platform_admins;
    truncate vault.secrets, net.http_request_queue, net._http_response, cron.job_run_details;
    update cron.job set active=true;`);
  for (const c of seedCompanies)
    await db.query('insert into companies(id,slug,data) values($1,$2,$3)', [c.id, c.slug, c]);
  for (const p of seedProducts)
    await db.query('insert into products(id,company_id,data) values($1,$2,$3)', [
      p.id,
      p.companyId,
      p,
    ]);
  // Counts by clock hour would straddle two hours if a test began in an hour's last seconds.
  const left = 3600000 - (Date.now() % 3600000);
  if (left < 5000) await new Promise((resolve) => setTimeout(resolve, left + 100));
});
afterAll(async () => {
  await db.close();
});

describe('email alerts go to the person who asked for them (F56)', () => {
  it('returns each subscriber their own address and none for a removed member', async () => {
    const [a, b, outsider] = [randomUUID(), randomUUID(), randomUUID()];
    await db.query(
      "insert into auth.users(id,email,email_confirmed_at) values($1,'a@example.test',now()),($2,'b@example.test',now()),($3,'c@example.test',now())",
      [a, b, outsider],
    );
    await db.query("insert into company_memberships values($1,$2,'staff'),($1,$3,'owner')", [
      company.id,
      a,
      b,
    ]);
    for (const user of [a, b]) await rpc('configure_alerts', [company.id, user, true, 10]);
    expect(await rpc('alert_recipient', [company.id, a])).toBe('a@example.test');
    expect(await rpc('alert_recipient', [company.id, b])).toBe('b@example.test');
    expect(await rpc('alert_recipient', [company.id, outsider])).toBeNull();
    expect(await rpc('alert_recipient', [other.id, a])).toBeNull();

    const { order } = await placedOrder();
    await ageOrder(order.id, '20 minutes');
    const queued = async () =>
      (
        await db.query<{ user: string }>(
          "select data->'payload'->>'userId' as user from jobs where data->>'kind'='staff_alert'",
        )
      ).rows
        .map((r) => r.user)
        .sort();
    expect(await rpc('queue_staff_alerts')).toBe(2);
    expect(await queued()).toEqual([a, b].sort());

    await db.query('delete from company_memberships where company_id=$1 and user_id=$2', [
      company.id,
      b,
    ]);
    expect(await rpc('alert_recipient', [company.id, b])).toBeNull();
    expect(await rpc('alert_recipient', [company.id, a])).toBe('a@example.test');
    await db.exec(
      "update alert_subscriptions set last_queued_at=now()-interval '2 hours'; delete from jobs where data->>'kind'='staff_alert';",
    );
    expect(await rpc('queue_staff_alerts')).toBe(1);
    expect(await queued()).toEqual([a]);
  });
});

describe('erasing a customer (F11, F69)', () => {
  const connection = '756bc31b-63af-4ce9-8324-1fd87803ae71';
  const address = (peer: string) => ({
    connectionId: connection,
    generation: 2,
    provider: 'baileys' as const,
    peer,
  });
  const stream = (peer: string) => `${connection}:2:${peer}`;
  const done = async (job: Job) => {
    await rpc('insert_job', [{ ...job, status: 'done' }, null]);
    return job.id;
  };

  it('finds every format of a whole number on WhatsApp, with its jobs, block and receipts', async () => {
    await pause();
    const meta = await chat('923001234567');
    const linked = await chat('+923001234567', { whatsappAddress: address('100000001@lid') });
    const demo = await chat('923001234567', {}, company.id, 'demo');
    const unknownNumber = await chat('', { whatsappAddress: address('100000002@lid') });
    const someoneElse = await chat('+923007654321');
    const outside = await chat('923001234567', {}, other.id);
    const erased = [
      await done(makeJob(company.id, 'incoming', { phone: '923001234567', text: 'private' })),
      // Saved by the linked phone before WhatsApp shared the number.
      await done(
        makeJob(company.id, 'incoming', {
          phone: '',
          streamKey: stream('100000001@lid'),
          whatsappAddress: address('100000001@lid'),
          text: 'private, number not known yet',
        }),
      ),
      await done(
        makeJob(company.id, 'incoming', {
          phone: '+923001234567',
          streamKey: stream('100000001@lid'),
          text: 'private',
        }),
      ),
      await done(makeJob(company.id, 'whatsapp_send', { conversationId: linked.id, text: 'hi' })),
    ];
    const kept = [
      await done(
        makeJob(company.id, 'incoming', {
          phone: '',
          streamKey: stream('100000002@lid'),
          text: 'a',
        }),
      ),
      await done(makeJob(company.id, 'incoming', { phone: '+923007654321', text: 'b' })),
      await done(makeJob(other.id, 'incoming', { phone: '923001234567', text: 'c' })),
    ];
    await block(meta.id, 'block-1', ['pn:923001234567'], 'Zainab');
    // A later message with the privacy ID adds a second row to the same block.
    expect(
      await rpc('blocked_customer_hit', [company.id, ['lid:100000001', 'pn:923001234567']]),
    ).toBe('block-1');
    await block(someoneElse.id, 'block-2', ['pn:923007654321'], 'Ali');
    await rpc('record_delivery', [company.id, 'wamid-unlinked', 'read', null, null, null]);
    await rpc('record_delivery', [company.id, 'wamid-kept', 'sent', someoneElse.id, 'm1', null]);
    await rpc('record_delivery', [other.id, 'wamid-other', 'read', null, null, null]);

    expect(await rpc('erase_customer', [company.id, '+92 300 1234567'])).toBe(2);

    const left = (await db.query<{ id: string }>('select id from conversations')).rows
      .map((r) => r.id)
      .sort();
    expect(left).toEqual([demo.id, unknownNumber.id, someoneElse.id, outside.id].sort());
    for (const id of erased) {
      expect(await payloadOf(id)).toEqual({});
      expect(await scalar('select status as value from jobs where id=$1', [id])).toBe('done');
    }
    for (const id of kept) expect(await payloadOf(id)).not.toEqual({});
    // The block still applies, but no longer names the customer or points at the erased chat.
    expect(
      (
        await db.query(
          'select key,block_id,label,conversation_id from blocked_customers where company_id=$1 order by key',
          [company.id],
        )
      ).rows,
    ).toEqual([
      {
        key: 'lid:100000001',
        block_id: 'block-1',
        label: 'Erased customer',
        conversation_id: null,
      },
      {
        key: 'pn:923001234567',
        block_id: 'block-1',
        label: 'Erased customer',
        conversation_id: null,
      },
      {
        key: 'pn:923007654321',
        block_id: 'block-2',
        label: 'Ali',
        conversation_id: someoneElse.id,
      },
    ]);
    expect(await rpc('blocked_customer_hit', [company.id, ['pn:923001234567']])).toBe('block-1');
    const list = await rpc<BlockedCustomer[]>('list_blocked_customers', [company.id]);
    expect(list.find((b) => b.blockId === 'block-1')).not.toHaveProperty('conversationId');
    expect(list.find((b) => b.blockId === 'block-1')!.label).toBe('Erased customer');
    expect(
      (await db.query<{ id: string }>('select external_id as id from message_deliveries')).rows
        .map((r) => r.id)
        .sort(),
    ).toEqual(['wamid-kept', 'wamid-other']);
  });

  it('never compares digits for a partial or empty number', async () => {
    await pause();
    const unknownNumber = await chat('', { whatsappAddress: address('100000003@lid') });
    await chat('923001234567');
    await chat('test-customer-1', {}, company.id, 'demo');
    for (const typed of ['++++', '1234', '0300 1234567', '92300123'])
      expect(await rpc('erase_customer', [company.id, typed]), typed).toBe(0);
    for (const typed of ['', '   '])
      await expect(rpc('erase_customer', [company.id, typed])).rejects.toThrow(
        'Customer phone number required',
      );
    expect(await scalar('select count(*)::int as value from conversations')).toBe(3);
    // The exact text still works for anything else, such as a test chat.
    expect(await rpc('erase_customer', [company.id, 'test-customer-1'])).toBe(1);
    expect(await rpc('erase_customer', [company.id, '923001234567'])).toBe(1);
    expect(
      (await db.query<{ id: string }>('select id from conversations')).rows.map((r) => r.id),
    ).toEqual([unknownNumber.id]);
  });

  it('lets a block outlive a chat removed by retention, without pointing at it', async () => {
    const old = await chat('', { whatsappAddress: address('100000004@lid') });
    await chat('', { whatsappAddress: address('100000005@lid') });
    await block(old.id, 'block-r', ['lid:100000004'], 'Spammer');
    const own = await done(
      makeJob(company.id, 'incoming', { phone: '', streamKey: stream('100000004@lid'), text: 'x' }),
    );
    const someoneElses = await done(
      makeJob(company.id, 'incoming', { phone: '', streamKey: stream('100000005@lid'), text: 'y' }),
    );
    await db.query(
      "update conversations set updated_at=now()-interval '120 days',data=data||jsonb_build_object('updatedAt',now()-interval '120 days','lastInboundAt',now()-interval '120 days') where id=$1",
      [old.id],
    );
    await rpc('configure_retention', [company.id, 30, 'owner']);
    await db.query(
      "update retention_policies set eligible_after=now()-interval '1 minute' where company_id=$1",
      [company.id],
    );
    expect(await rpc('run_retention', [company.id])).toBe(1);
    expect((await db.query('select label,conversation_id from blocked_customers')).rows).toEqual([
      { label: 'Spammer', conversation_id: null },
    ]);
    expect(await payloadOf(own)).toEqual({});
    // Another customer whose number is unknown keeps their saved messages.
    expect(await payloadOf(someoneElses)).toMatchObject({ text: 'y' });
  });
});

describe('automatic notices are not a staff reply (G7.7, G5.1)', () => {
  const message = (role: Message['role'], text: string, extra: Partial<Message> = {}): Message => ({
    id: randomUUID(),
    role,
    text,
    createdAt: now(),
    ...extra,
  });
  async function humanChat(messages: Message[]) {
    const c = await chat(nextPhone(), { mode: 'human', messages });
    await db.query("update conversations set updated_at=now()-interval '30 minutes' where id=$1", [
      c.id,
    ]);
    return c.id;
  }
  const asked = () => message('customer', 'Please cancel my order');

  it('keeps a waiting customer in the bell and email alerts after an order status change', async () => {
    const answered = await humanChat([
      asked(),
      message('staff', 'Calling you now'),
      message('staff', 'Order ORD-1 is now preparing.', { notice: true }),
    ]);
    expect(await attention()).toMatchObject({ handoffs: 0, total: 0 });
    expect(await rpc('has_overdue_attention', [company.id, 10])).toBe(false);

    const waiting = [
      // As the order status route writes it today.
      await humanChat([
        asked(),
        message('staff', 'Order ORD-1 is now preparing.', { notice: true }),
      ]),
      // Saved before notices were marked.
      await humanChat([asked(), message('staff', 'Order ORD-2 is now out for delivery.')]),
      // If the notice is written as the bot's.
      await humanChat([
        asked(),
        message('assistant', 'Order ORD-3 is now ready.', { notice: true }),
      ]),
      // Several notices in a row.
      await humanChat([
        message('assistant', 'I have asked a staff member to help.'),
        message('staff', 'Order ORD-4 is now accepted.', { notice: true }),
        message('staff', 'Order ORD-4 is now preparing.', { notice: true }),
      ]),
      // No messages at all, as before.
      await humanChat([]),
    ];
    const alerts = await attention();
    expect(alerts.handoffs).toBe(waiting.length);
    expect(alerts.items.map((a) => a.entityId).sort()).toEqual([...waiting].sort());
    expect(alerts.items.map((a) => a.entityId)).not.toContain(answered);
    expect(await rpc('has_overdue_attention', [company.id, 10])).toBe(true);
  });

  it('asks for an email about an order waiting 15 minutes, whatever the alert delay', async () => {
    const { order } = await placedOrder();
    await ageOrder(order.id, '14 minutes');
    expect(await rpc('has_overdue_attention', [company.id, 60])).toBe(false);
    expect(await rpc('has_overdue_attention', [company.id, 10])).toBe(true);
    await ageOrder(order.id, '16 minutes');
    expect(await rpc('has_overdue_attention', [company.id, 60])).toBe(true);
    expect(await rpc('has_overdue_attention', [company.id, 120])).toBe(true);
  });
});

describe('spam safety net (G4.2)', () => {
  async function usage(count: number, companyId = company.id) {
    await db.query(
      `insert into usage_events(id,company_id,cost_usd,data,created_at)
       select $1::text||'-'||i, $2::text, 0.0001, jsonb_build_object('id',$1::text||'-'||i,
         'companyId',$2::text,'costUsd',0.0001,'createdAt',now(),'conversationId','chat-'||i), now()
       from generate_series(1,$3::int) i`,
      [randomUUID(), companyId, count],
    );
  }
  const setLimits = (aiLimits: unknown) =>
    db.query("update companies set data=jsonb_set(data,'{aiLimits}',$2::jsonb) where id=$1", [
      company.id,
      JSON.stringify(aiLimits),
    ]);
  const reserve = (id: string) =>
    rpc('reserve_ai_call', [
      company.id,
      id,
      0.01,
      new Date(Date.now() + 60000).toISOString(),
      'chat-x',
      null,
    ]);

  it('defaults to 1,500 AI replies an hour and 100 per customer, as the app does', async () => {
    expect((await db.query("select * from public.ai_limit_settings('{}')")).rows[0]).toEqual({
      replies_per_hour: 1500,
      replies_per_customer: 100,
    });
    // The per-minute message limit is checked in code only, so SQL has no counterpart for it.
    expect(AI_LIMIT_DEFAULTS).toEqual({
      repliesPerHour: 1500,
      repliesPerCustomerPerHour: 100,
      messagesPerCustomerPerMinute: 25,
    });
    expect(await rpc('ai_limit_status', [company.id])).toMatchObject({
      repliesPerHour: 1500,
      repliesPerCustomerPerHour: 100,
    });
  });

  it('warns at 80% of the hourly limit, then shows the reached limit instead', async () => {
    await setLimits({ repliesPerHour: 20 });
    await usage(15);
    expect(await attention()).toMatchObject({ total: 0, limits: 0, items: [] });
    expect(await rpc('has_overdue_attention', [company.id, 10])).toBe(false);
    await usage(1);
    const warned = await attention();
    expect(warned).toMatchObject({ total: 1, limits: 0 });
    expect(warned.items).toEqual([
      {
        id: `limit:hourly_near:${hourKey()}`,
        kind: 'limit',
        entityId: company.id,
        createdAt: expect.any(String),
        scope: 'hourly_near',
        resetsAt: expect.any(String),
      },
    ]);
    expect(Date.parse(warned.items[0]!.createdAt)).toBe(hourStart());
    expect(Date.parse(warned.items[0]!.resetsAt!)).toBe(hourStart() + 3600000);
    expect(await rpc('has_overdue_attention', [company.id, 10])).toBe(true);
    expect(await attention(other.id)).toMatchObject({ total: 0 });
    // Reached: the reached limit replaces the warning for the rest of the hour.
    await usage(4);
    expect(await reserve('over')).toMatchObject({ ok: false, limit: 'hourly' });
    const reached = await attention();
    expect(reached).toMatchObject({ total: 1, limits: 1 });
    expect(reached.items.map((a) => a.id)).toEqual([`limit:hourly:${hourKey()}`]);
  });

  it('warns at 1,200 replies under the default limit', async () => {
    await usage(1199);
    expect(await attention()).toMatchObject({ total: 0 });
    await usage(1);
    expect((await attention()).items.map((a) => a.id)).toEqual([`limit:hourly_near:${hourKey()}`]);
  });
});

describe('pipeline health (F02)', () => {
  const health = () => rpc<PipelineHealth>('orderly_pipeline_health');
  async function job(
    id: string,
    {
      status = 'pending',
      dueMinutesAgo = 5,
      attempts = 0,
      kind = 'whatsapp_send',
      stream,
      leaseMinutesAgo,
    }: {
      status?: Job['status'];
      dueMinutesAgo?: number;
      attempts?: number;
      kind?: Job['kind'];
      stream?: string;
      leaseMinutesAgo?: number;
    } = {},
  ) {
    const at = minutesAgo(dueMinutesAgo);
    await rpc('insert_job', [
      {
        id,
        companyId: company.id,
        kind,
        payload: kind === 'incoming' ? { phone: '', streamKey: stream ?? id } : {},
        status,
        attempts,
        nextRunAt: at,
        createdAt: at,
        ...(leaseMinutesAgo === undefined ? {} : { leaseUntil: minutesAgo(leaseMinutesAgo) }),
      },
      null,
    ]);
  }

  it('reports saved work that is not being sent, and why', async () => {
    await job('never-sent');
    // Not set up yet: nothing is ever sent (and last_dispatched_at stays empty).
    expect(await health()).toMatchObject({
      status: 'unconfigured',
      stalledJobs: 1,
      schedulerConfigured: false,
      recoveryScheduled: true,
      oldestDueAt: expect.stringMatching(ISO),
    });
    await configure();
    await job('retried', { attempts: 2, dueMinutesAgo: 6 });
    await job('lease-ran-out', { status: 'processing', attempts: 1, leaseMinutesAgo: 5 });
    await job('other-customer', { kind: 'incoming', stream: 'stream-2' });
    // Not stalled: just due, in the future, being worked on, given up, finished.
    await job('just-due', { dueMinutesAgo: 1 });
    await job('later', { dueMinutesAgo: -60 });
    await job('working', { status: 'processing', attempts: 1, leaseMinutesAgo: -1 });
    await job('lease-just-ran-out', { status: 'processing', attempts: 1, leaseMinutesAgo: 1 });
    await job('exhausted', { attempts: 5 });
    await job('done', { status: 'done' });
    // Held behind the same customer's failed message, which already shows as a failed job.
    await job('failed-head', {
      kind: 'incoming',
      stream: 'stream-1',
      status: 'failed',
      dueMinutesAgo: 10,
    });
    await job('behind-failure', { kind: 'incoming', stream: 'stream-1' });
    const stalled = await health();
    expect(stalled).toMatchObject({
      status: 'stalled',
      stalledJobs: 4,
      schedulerConfigured: true,
      recoveryScheduled: true,
      lastRecoverRun: null,
      recentWorkerErrors: 0,
    });
    expect(Date.parse(stalled.oldestDueAt!)).toBeLessThan(Date.now() - 5.5 * 60000);
    expect(stalled.dbSizeBytes).toBeGreaterThan(0);

    await db.exec('truncate public.jobs cascade');
    expect(await health()).toMatchObject({ status: 'ok', stalledJobs: 0, oldestDueAt: null });
    await db.exec("update cron.job set active=false where jobname='orderly-recover-jobs'");
    expect(await health()).toMatchObject({ status: 'unconfigured', recoveryScheduled: false });
  });

  it('shows the last recovery run and recent worker errors', async () => {
    await configure();
    await db.exec(`
      insert into cron.job_run_details(jobid,status,end_time)
        select jobid,'failed',now()-interval '2 minutes' from cron.job where jobname='orderly-recover-jobs';
      insert into cron.job_run_details(jobid,status,end_time)
        select jobid,'succeeded',now()-interval '30 seconds' from cron.job where jobname='orderly-recover-jobs';
      insert into cron.job_run_details(jobid,status,end_time)
        select jobid,'failed',now() from cron.job where jobname='orderly-staff-alerts';
      insert into net._http_response(id,status_code,timed_out,error_msg,created) values
        (1,202,false,null,now()),(2,401,false,null,now()),(3,null,true,'Timeout',now()),
        (4,500,false,null,now()-interval '1 hour');
    `);
    const result = await health();
    expect(result.lastRecoverRun).toEqual({ status: 'succeeded', at: expect.stringMatching(ISO) });
    expect(Date.now() - Date.parse(result.lastRecoverRun!.at)).toBeLessThan(60000);
    expect(result.recentWorkerErrors).toBe(2);
  });
});

describe('daily purge of operational rows (F62)', () => {
  async function traces(count: number, age: string, conversationId: string | null = null) {
    await db.query(
      `insert into traces(id,company_id,conversation_id,data,created_at)
       select $1::text||'-'||i, $2::text, $3::text, jsonb_strip_nulls(jsonb_build_object('id',$1::text||'-'||i,
         'companyId',$2::text,'conversationId',$3::text,'action','whatsapp.read','detail','Meta message x','createdAt',now())),
         now()-$4::interval
       from generate_series(1,$5::int) i`,
      [randomUUID(), company.id, conversationId, age, count],
    );
  }
  const count = (table: string) => scalar<number>(`select count(*)::int as value from ${table}`);

  it('removes old traces and unlinked receipts and empties old finished jobs, keeping their keys', async () => {
    await configure();
    const c = await chat('+923001111111');
    await traces(3, '100 days');
    await traces(1, '100 days', c.id);
    await traces(2, '10 days');
    const audits = await count('audit_events');
    const old = minutesAgo(20 * 24 * 60);
    const stream = { phone: '+923001111111', streamKey: 'stream-a' };
    const finished = {
      ...makeJob(company.id, 'incoming', { ...stream, text: 'private' }),
      status: 'done',
      createdAt: old,
      nextRunAt: old,
      error: 'provider said private',
    } as Job;
    const recent = {
      ...makeJob(company.id, 'incoming', { ...stream, text: 'recent' }),
      status: 'done',
      createdAt: minutesAgo(5 * 24 * 60),
    } as Job;
    const failed = {
      ...makeJob(company.id, 'whatsapp_send', { conversationId: c.id, text: 'x' }),
      status: 'failed',
      createdAt: old,
    } as Job;
    // The customer's next message, due: emptying the finished one must not dispatch it again.
    const next = makeJob(company.id, 'incoming', { ...stream, text: 'next' });
    expect(await rpc('insert_job', [finished, 'meta:wamid-1'])).toBe(true);
    expect(await rpc('insert_job', [recent, 'meta:wamid-2'])).toBe(true);
    await rpc('insert_job', [failed, null]);
    await rpc('insert_job', [next, null]);
    await rpc('record_delivery', [company.id, 'unlinked-old', 'read', null, null, null]);
    await rpc('record_delivery', [company.id, 'unlinked-new', 'read', null, null, null]);
    await rpc('record_delivery', [company.id, 'linked-old', 'sent', c.id, 'm1', null]);
    await db.exec(
      "update message_deliveries set created_at=now()-interval '100 days' where external_id in ('unlinked-old','linked-old')",
    );

    expect(await rpc('purge_orderly_operations')).toBe(6);
    expect(await count('traces')).toBe(2);
    expect(await count('audit_events')).toBe(audits);
    expect(await scalar('select data as value from jobs where id=$1', [finished.id])).toEqual({
      ...finished,
      payload: {},
      error: undefined,
    });
    expect(await scalar('select status as value from jobs where id=$1', [finished.id])).toBe(
      'done',
    );
    // A webhook retry is still recognised.
    expect(await rpc('insert_job', [{ ...finished, id: randomUUID() }, 'meta:wamid-1'])).toBe(
      false,
    );
    expect(await payloadOf(recent.id)).toMatchObject({ text: 'recent' });
    expect(await payloadOf(failed.id)).toMatchObject({ text: 'x' });
    expect(await count('net.http_request_queue')).toBe(0);
    expect(
      (await db.query<{ id: string }>('select external_id as id from message_deliveries')).rows
        .map((r) => r.id)
        .sort(),
    ).toEqual(['linked-old', 'unlinked-new']);
    expect(await rpc('purge_orderly_operations')).toBe(0);
  });

  it('keeps each run short and catches up over later runs', async () => {
    await traces(25, '91 days');
    expect(await rpc('purge_orderly_operations', [2])).toBe(8);
    expect(await rpc('purge_orderly_operations', [10])).toBe(17);
    expect(await count('traces')).toBe(0);
  });

  it('runs daily before opening time and keeps every Orderly schedule’s history short', async () => {
    expect(
      (await db.query("select schedule,command from cron.job where jobname='orderly-ops-purge'"))
        .rows,
    ).toEqual([{ schedule: '41 0 * * *', command: 'select public.purge_orderly_operations()' }]);
    await db.exec(`
      select cron.schedule('unrelated-job','* * * * *','select 1;');
      insert into cron.job_run_details(jobid,end_time) select jobid,now()-interval '4 days' from cron.job;
      insert into cron.job_run_details(jobid,end_time) select jobid,now()-interval '1 day' from cron.job;
    `);
    const orderly = await scalar<number>(
      "select count(*)::int as value from cron.job where jobname like 'orderly-%'",
    );
    // Recovery, its own pruning, retention, staff alerts, menu purge and this purge, at least.
    expect(orderly).toBeGreaterThanOrEqual(6);
    expect(await rpc('prune_orderly_cron_history')).toBe(orderly);
    expect(
      await scalar(
        "select count(*)::int as value from cron.job_run_details join cron.job using(jobid) where jobname='unrelated-job'",
      ),
    ).toBe(2);
    await db.exec("delete from cron.job where jobname='unrelated-job'");
  });
});

describe('order follow-ups (G7.1)', () => {
  const followups = async () =>
    (
      await db.query<{ data: Job; dedupe_key: string }>(
        "select data,dedupe_key from jobs where data->>'kind'='order_followup' order by created_at",
      )
    ).rows;

  it('queues one reminder per live order still waiting after 15 minutes, once', async () => {
    const waiting = await placedOrder();
    await ageOrder(waiting.order.id, '20 minutes');
    const fresh = await placedOrder();
    await ageOrder(fresh.order.id, '10 minutes');
    const stale = await placedOrder();
    await ageOrder(stale.order.id, '25 hours');
    const accepted = await placedOrder();
    await ageOrder(accepted.order.id, '20 minutes');
    await db.query(`update orders set data=jsonb_set(data,'{status}','"accepted"') where id=$1`, [
      accepted.order.id,
    ]);
    const blocked = await placedOrder();
    await ageOrder(blocked.order.id, '20 minutes');
    await block(blocked.conversation.id, 'block-1', [
      `pn:${blocked.conversation.customerPhone.slice(1)}`,
    ]);
    const sandbox = await placedOrder(nextPhone(), 'demo');
    await ageOrder(sandbox.order.id, '20 minutes');

    // Nothing could send it before the worker is set up.
    expect(await rpc('queue_order_followups')).toBe(0);
    await configure();
    expect(await rpc('queue_order_followups')).toBe(1);
    const [queued] = await followups();
    expect(queued!.dedupe_key).toBe(`order-followup:${waiting.order.id}`);
    expect(queued!.data).toEqual({
      id: expect.any(String),
      companyId: company.id,
      kind: 'order_followup',
      payload: { orderId: waiting.order.id, conversationId: waiting.conversation.id },
      status: 'pending',
      attempts: 0,
      nextRunAt: expect.stringMatching(ISO),
      createdAt: expect.stringMatching(ISO),
    });
    expect(await rpc('queue_order_followups')).toBe(0);
    expect(await followups()).toHaveLength(1);
    // Staff accepting it later does not queue another.
    await db.query(`update orders set data=jsonb_set(data,'{status}','"accepted"') where id=$1`, [
      waiting.order.id,
    ]);
    expect(await rpc('queue_order_followups')).toBe(0);
  });

  it('is sent, retried and given up on by the existing job functions', async () => {
    await configure();
    const { order, conversation } = await placedOrder();
    await ageOrder(order.id, '20 minutes');
    expect(await rpc('queue_order_followups')).toBe(1);
    const queued = (await followups())[0]!.data;
    expect(await rpc('recover_orderly_jobs')).toBe(1);
    expect(
      (await db.query("select body->>'jobId' as id from net.http_request_queue")).rows,
    ).toEqual([{ id: queued.id }]);
    expect(
      await rpc('claim_job', [queued.id, now(), new Date(Date.now() + 90000).toISOString()]),
    ).toMatchObject({ id: queued.id, status: 'processing', attempts: 1 });
    await db.query(
      `update jobs set attempts=5,lease_until=now()-interval '1 minute',data=data||'{"attempts":5}'::jsonb where id=$1`,
      [queued.id],
    );
    const before = await scalar('select data as value from conversations where id=$1', [
      conversation.id,
    ]);
    expect(await rpc('fail_exhausted_orderly_jobs', [20])).toBe(1);
    expect(await scalar('select status as value from jobs where id=$1', [queued.id])).toBe(
      'failed',
    );
    expect(
      await scalar('select data as value from conversations where id=$1', [conversation.id]),
    ).toEqual(before);
    expect(await attention()).toMatchObject({ failures: 1 });
  });

  it('stops waiting reminders when WhatsApp is disconnected or the customer is erased', async () => {
    await configure();
    const first = await placedOrder();
    const second = await placedOrder();
    for (const { order } of [first, second]) await ageOrder(order.id, '20 minutes');
    expect(await rpc('queue_order_followups')).toBe(2);
    await pause();
    expect(await rpc('erase_customer', [company.id, first.conversation.customerPhone])).toBe(1);
    await rpc('disconnect_integration', [company.id, 'whatsapp']);
    for (const { data } of await followups())
      expect(data).toMatchObject({ status: 'done', payload: {} });
    expect(await followups()).toHaveLength(2);
  });

  it('runs every 5 minutes', async () => {
    expect(
      (
        await db.query(
          "select schedule,command from cron.job where jobname='orderly-order-followups'",
        )
      ).rows,
    ).toEqual([{ schedule: '*/5 * * * *', command: 'select public.queue_order_followups()' }]);
  });
});

describe('server-only access and the migrations ledger (F57)', () => {
  it('records each migration from 202610200001 on, once', async () => {
    const ledger = async () =>
      (await db.query('select name,applied_at from orderly_schema_migrations order by name')).rows;
    const before = await ledger();
    expect(before.map((r) => (r as { name: string }).name)).toEqual(recorded);
    for (const file of recorded) await db.exec(migration(file));
    expect(await ledger()).toEqual(before);
  });

  it.each(['anon', 'authenticated'])('denies %s the new functions and the ledger', async (role) => {
    const signatures = [
      'public.orderly_pipeline_health()',
      'public.purge_orderly_operations(integer)',
      'public.prune_orderly_cron_history()',
      'public.queue_order_followups()',
      'public.disconnect_integration(text,text)',
      'public.awaits_staff_reply(jsonb)',
      'public.ai_hourly_warning(text)',
      'public.ai_limit_settings(jsonb)',
      'public.alert_recipient(text,uuid)',
      'public.erase_customer(text,text)',
      'public.run_retention(text)',
      'public.staff_attention(text)',
      'public.has_overdue_attention(text,integer)',
      'public.enforce_catalog_id()',
    ];
    for (const signature of signatures) {
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
    await db.exec(`set role ${role}`);
    try {
      await expect(rpc('orderly_pipeline_health')).rejects.toThrow(DENIED);
      await expect(db.query('select * from public.orderly_schema_migrations')).rejects.toThrow(
        DENIED,
      );
    } finally {
      await db.exec('reset role');
    }
    await db.exec('set role service_role');
    try {
      expect(await rpc<PipelineHealth>('orderly_pipeline_health')).toMatchObject({
        status: 'unconfigured',
      });
      expect(await scalar('select count(*)::int as value from orderly_schema_migrations')).toBe(
        recorded.length,
      );
    } finally {
      await db.exec('reset role');
    }
  });
});

// Last: it re-applies every file to this database.
describe('replaying the migrations folder (G2.3, F57)', () => {
  it('changes no function and pauses no business: superseded files refuse to run', async () => {
    const live = {
      ...company,
      id: 'unlabelled-live',
      slug: 'unlabelled-live',
      botEnabled: true,
      modelVerification: { fingerprint: 'verified', checkedAt: now() },
      ai: { ...company.ai, provider: 'anthropic', model: 'claude-haiku-5-5' },
    };
    await db.query('insert into companies(id,slug,data) values($1,$2,$3)', [
      live.id,
      live.slug,
      live,
    ]);
    const snapshot = async () => ({
      functions: (
        await db.query(
          `select p.oid::regprocedure::text as signature, md5(p.prosrc) as body, coalesce(p.proacl::text,'') as acl
           from pg_proc p where p.pronamespace='public'::regnamespace order by 1`,
        )
      ).rows,
      companies: (await db.query('select id,data from companies order by id')).rows,
      schedules: (
        await db.query('select jobname,schedule,command,active from cron.job order by jobname')
      ).rows,
      platformBudget: await scalar("select to_regclass('public.platform_limits')::text as value"),
    });
    const before = await snapshot();
    const refused: string[] = [];
    for (const file of files)
      try {
        await db.exec(migration(file));
      } catch (error) {
        if (/do not re-run it/.test((error as Error).message)) refused.push(file);
      }
    expect(refused).toEqual([
      '202609110001_job_dispatch.sql',
      '202609180003_platform_budget.sql',
      '202610160001_delivery_followups.sql',
      '202610170001_business_keys_only.sql',
      '202610180001_spam_protection.sql',
    ]);
    expect(await snapshot()).toEqual(before);
  });
});
