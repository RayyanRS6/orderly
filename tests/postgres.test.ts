import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import { createConversation, processTurn } from '../src/domain/engine';
import { makeJob } from '../server/jobs';
import type {
  AiCallReservation,
  AiLimitStatus,
  BlockedCustomer,
  BotAction,
  Company,
  Conversation,
  Order,
  StaffAttention,
} from '../src/shared/types';
import { defaultBot } from '../src/shared/bot';
import { AI_LIMIT_DEFAULTS, AI_LIMIT_RANGES, effectiveAiLimits } from '../src/shared/models';
import {
  blockCustomerArgs,
  createMenuDraftArgs,
  placeWebOrderArgs,
  reserveAiCallArgs,
} from '../server/storage/supabase';
import { buildWebOrder } from '../src/domain/web-order';
import type { MenuDraftResult, WebCart, WebOrderClaim, WebOrderOutcome } from '../src/shared/menu';

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
function pendingOrder(channel: Conversation['channel'] = 'whatsapp', phone = '+923000000099') {
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

// Every migration, in the order production applied them by hand.
const chain = [
  '202609090001_initial.sql',
  '202609090002_order_transitions.sql',
  '202609110001_job_dispatch.sql',
  '202609160001_launch_hardening.sql',
  '202609160002_message_delivery.sql',
  '202609170001_retention.sql',
  '202609170002_retention_schedule.sql',
  '202609170003_staff_attention.sql',
  '202609180001_email_alerts.sql',
  '202609180002_email_alert_schedule.sql',
  '202609180003_platform_budget.sql',
  '202609200001_whatsapp_gateway.sql',
  '202610160001_delivery_followups.sql',
  '202610170001_business_keys_only.sql',
  '202610180001_spam_protection.sql',
  '202610190001_menu_page.sql',
  '202610190002_menu_ordering.sql',
  '202610190003_menu_purge_schedule.sql',
  '202610200001_prelaunch_fixes.sql',
  '202610200002_order_followups.sql',
  '202610200003_order_flow.sql',
  '202610210001_deals.sql',
  '202610220001_business_deletion.sql',
];
// PGlite cannot install pg_cron, pg_net or Vault: their schemas are stubbed and the extension
// lines skipped, as in scheduler.test.ts.
const migrationSql = (file: string) =>
  readFileSync(`supabase/migrations/${file}`, 'utf8').replace(/^create extension [^;]+;\r?$/gm, '');

beforeAll(async () => {
  await db.exec(
    `create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz); create table auth.mfa_factors(id uuid primary key,user_id uuid,status text); create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{"aal":"aal1"}') $$; create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; grant usage on schema auth to authenticated,service_role; grant execute on function auth.uid() to authenticated,service_role;`,
  );
  await db.exec(`
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
  for (const migration of chain) await db.exec(migrationSql(migration));
  await db.query('insert into auth.users(id) values($1),($2)', [ownerId, outsiderId]);
}, 30000);
beforeEach(async () => {
  await db.exec('reset role; update auth.users set email=null,email_confirmed_at=null');
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
  it('caps AI spending by each business’s own budget, with no shared Orderly allowance', async () => {
    const expiry = new Date(Date.now() + 60000).toISOString();
    // Both seeds allow $10 a month. Before, a shared $100 allowance also applied.
    expect(await rpc('reserve_budget', [company.id, 'turn-a', 9, expiry])).toBe(true);
    expect(await rpc('reserve_budget', [company.id, 'turn-b', 2, expiry])).toBe(false);
    expect(await rpc('reserve_budget', [other.id, 'turn-c', 10, expiry])).toBe(true);
    await rpc('settle_budget', [
      'turn-a',
      { id: 'turn-a', companyId: company.id, costUsd: 3, createdAt: now() },
    ]);
    expect(await scalar("select data->>'funding' value from usage_events where id='turn-a'")).toBe(
      null,
    );
    expect(await rpc('reserve_budget', [company.id, 'turn-d', 7, expiry])).toBe(true);
    expect(await rpc('reserve_budget', [company.id, 'turn-e', 0.01, expiry])).toBe(false);
    expect(await scalar("select to_regclass('public.platform_limits')::text value")).toBe(null);
    expect(
      await scalar(
        "select count(*)::int value from information_schema.columns where table_name='budget_reservations' and column_name='funding'",
      ),
    ).toBe(0);
    await expect(rpc('platform_budget', [])).rejects.toThrow('does not exist');
  });
  it('moves every business to its own key, pausing any that relied on Orderly’s', async () => {
    const shared = {
      ...company,
      id: 'shared-key',
      slug: 'shared-key',
      botEnabled: true,
      modelVerification: { fingerprint: 'old', checkedAt: now() },
      ai: { ...company.ai, provider: 'openai', model: 'gpt-5.5-mini', keyMode: 'platform' },
    };
    const unlabelled = {
      ...shared,
      id: 'unlabelled',
      slug: 'unlabelled',
      ai: { ...company.ai, provider: 'anthropic', model: 'claude-haiku-5-5' },
    };
    const demo = {
      ...shared,
      id: 'demo-shared',
      slug: 'demo-shared',
      ai: { ...company.ai, keyMode: 'platform' },
    };
    const own = {
      ...shared,
      id: 'own-key',
      slug: 'own-key',
      ai: { ...shared.ai, keyMode: 'own' },
    };
    for (const c of [shared, unlabelled, demo, own])
      await db.query('insert into companies(id,slug,data) values($1,$2,$3)', [c.id, c.slug, c]);
    const script = readFileSync('supabase/migrations/202610170001_business_keys_only.sql', 'utf8');
    // As before the first run, when the shared-budget table still existed and the spam
    // protection (202610180001), which makes this file refuse to run, was not applied yet.
    const reserveAiCall = 'public.reserve_ai_call(text,text,numeric,timestamptz,text,timestamptz)';
    await db.exec(`alter function ${reserveAiCall} rename to reserve_ai_call_later`);
    try {
      await db.exec('create table public.platform_limits(id boolean primary key default true)');
      await db.exec(script);
      // The new code then saves businesses without the label; a rerun must leave them alone.
      await db.query(
        "update companies set data=jsonb_set(data,'{ai}',(data->'ai')-'keyMode') where id=$1",
        [own.id],
      );
      await db.exec(script);
    } finally {
      await db.exec(
        `alter function public.reserve_ai_call_later(text,text,numeric,timestamptz,text,timestamptz) rename to reserve_ai_call`,
      );
    }
    expect(
      (await db.query<{ data: Company }>('select data from companies where id=$1', [own.id]))
        .rows[0]!.data.botEnabled,
    ).toBe(true);
    // Once the spam protection is applied, even a shared-budget table brought back by a replay
    // cannot make it pause the businesses saved since: the file refuses to run.
    await db.exec('create table public.platform_limits(id boolean primary key default true)');
    await expect(db.exec(script)).rejects.toThrow('do not re-run it');
    await db.exec('drop table public.platform_limits');
    expect(
      (await db.query<{ data: Company }>('select data from companies where id=$1', [own.id]))
        .rows[0]!.data.botEnabled,
    ).toBe(true);
    await db.query(
      "update companies set data=jsonb_set(data,'{ai,keyMode}','\"own\"') where id=$1",
      [own.id],
    );
    const rows = (
      await db.query<{ id: string; data: Record<string, any> }>(
        'select id,data from companies where id = any($1)',
        [[shared.id, unlabelled.id, demo.id, own.id]],
      )
    ).rows;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.data]));
    for (const id of [shared.id, unlabelled.id]) {
      expect(byId[id].botEnabled).toBe(false);
      expect(byId[id].modelVerification).toBeUndefined();
    }
    for (const id of [demo.id, own.id]) {
      expect(byId[id].botEnabled).toBe(true);
      expect(byId[id].modelVerification).toEqual(shared.modelVerification);
    }
    for (const id of [shared.id, unlabelled.id, demo.id, own.id])
      expect(byId[id].ai.keyMode).toBe('own');
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
    await expect(
      rpc('reserve_budget', [company.id, 'browser', 1, new Date(Date.now() + 60000).toISOString()]),
    ).rejects.toThrow('permission denied');
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

describe('people management on the existing schema', () => {
  const count = (sql: string, args: unknown[]) =>
    scalar(`select count(*)::int as value from ${sql}`, args);
  it('removes memberships, admin access and alert settings with a deleted account', async () => {
    const person = randomUUID();
    await db.query(
      "insert into auth.users(id,email,email_confirmed_at) values($1,'gone@example.test',now())",
      [person],
    );
    await db.query("insert into company_memberships values($1,$2,'owner'),($3,$2,'staff')", [
      company.id,
      person,
      other.id,
    ]);
    await db.query("insert into company_memberships values($1,$2,'owner')", [company.id, ownerId]);
    await db.query('insert into platform_admins values($1)', [person]);
    await rpc('configure_alerts', [company.id, person, true, 10]);
    expect(await count('alert_subscriptions where user_id=$1', [person])).toBe(1);
    await db.query('delete from auth.users where id=$1', [person]);
    expect(await count('company_memberships where user_id=$1', [person])).toBe(0);
    expect(await count('platform_admins where user_id=$1', [person])).toBe(0);
    expect(await count('alert_subscriptions where user_id=$1', [person])).toBe(0);
    expect(await count('companies where true', [])).toBe(seedCompanies.length);
    expect(await count('company_memberships where user_id=$1', [ownerId])).toBe(1);
  });
  it('keeps the last owner even for the platform admin, and rejects unknown accounts', async () => {
    const admin = randomUUID();
    const second = randomUUID();
    await db.query('insert into auth.users(id) values($1),($2)', [admin, second]);
    await db.query('insert into platform_admins values($1)', [admin]);
    await db.query("insert into company_memberships values($1,$2,'owner')", [company.id, ownerId]);
    await expect(rpc('manage_member', [company.id, ownerId, null, admin])).rejects.toThrow(
      'Keep another owner',
    );
    await rpc('manage_member', [company.id, second, 'owner', admin]);
    expect(
      await count("company_memberships where company_id=$1 and role='owner'", [company.id]),
    ).toBe(2);
    await rpc('manage_member', [company.id, ownerId, null, admin]);
    expect(await count('company_memberships where user_id=$1', [ownerId])).toBe(0);
    // No such account: the foreign key fails, which the server shows as a clear 404.
    await expect(
      rpc('manage_member', [company.id, randomUUID(), 'staff', admin]),
    ).rejects.toMatchObject({ code: '23503' });
  });
});

describe('real Postgres migrations and transactional invariants', () => {
  it('runs every migration file, in filename order', () => {
    expect(chain).toEqual(readdirSync('supabase/migrations').sort());
  });
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
  it('set_order_status: Accept goes straight to preparing, needs no call, and keeps a note', async () => {
    const { conversation, order } = pendingOrder();
    order.phoneConfirmationRequired = true;
    await commit(conversation, order);
    const note = { text: 'Called, all fine', at: now(), actorId: ownerId };
    await expect(
      rpc('set_order_status', [company.id, order.id, 'pending', 'accepted', now(), []]),
    ).rejects.toThrow('Invalid order status');
    expect(
      await rpc('set_order_status', [
        company.id,
        order.id,
        'pending',
        'preparing',
        now(),
        [],
        null,
        null,
        note,
      ]),
    ).toMatchObject({ status: 'preparing', staffNote: note });
    // Another staff member's competing change loses, and another business cannot touch it.
    expect(
      await rpc('set_order_status', [company.id, order.id, 'pending', 'rejected', now(), []]),
    ).toBeNull();
    expect(
      await rpc('set_order_status', [other.id, order.id, 'preparing', 'ready', now(), []]),
    ).toBeNull();
    await expect(
      rpc('set_order_status', [
        company.id,
        order.id,
        'preparing',
        'ready',
        now(),
        [],
        null,
        null,
        { ...note, text: 'x'.repeat(501) },
      ]),
    ).rejects.toThrow('Invalid staff note');
    await expect(
      rpc('set_order_status', [company.id, order.id, 'preparing', 'out_for_delivery', now(), []]),
    ).rejects.toThrow('Pickup orders cannot go out for delivery');
    expect(
      await rpc('set_order_status', [company.id, order.id, 'preparing', 'ready', now(), []]),
    ).toMatchObject({ status: 'ready', staffNote: note });
    expect(
      await rpc('set_order_status', [company.id, order.id, 'ready', 'completed', now(), []]),
    ).toMatchObject({ status: 'completed' });
  });
  it('set_order_status: a delivery order goes out for delivery', async () => {
    const { conversation, order } = pendingOrder();
    await commit(conversation, order);
    await db.query(
      `update orders set data=jsonb_set(data,'{fulfillment}','"delivery"') where id=$1`,
      [order.id],
    );
    await rpc('set_order_status', [company.id, order.id, 'pending', 'preparing', now(), []]);
    expect(
      await rpc('set_order_status', [
        company.id,
        order.id,
        'preparing',
        'out_for_delivery',
        now(),
        [],
      ]),
    ).toMatchObject({ status: 'out_for_delivery' });
    expect(await rpc('order_status_counts', [company.id, false])).toMatchObject({
      out_for_delivery: 1,
    });
    expect(
      await rpc('set_order_status', [
        company.id,
        order.id,
        'out_for_delivery',
        'completed',
        now(),
        [],
      ]),
    ).toMatchObject({ status: 'completed' });
  });
  it('order_status_counts: the steps staff act on, older accepted orders as preparing', async () => {
    const before = (await rpc('order_status_counts', [company.id, false])) as Record<
      string,
      number
    >;
    const placed = ['+923000000101', '+923000000102', '+923000000103'].map((phone) =>
      pendingOrder('whatsapp', phone),
    );
    for (const { conversation, order } of placed)
      expect(await commit(conversation, order)).toBe(true);
    // One from before this flow, still 'accepted', and one ready for pickup.
    await db.query(`update orders set data=jsonb_set(data,'{status}','"accepted"') where id=$1`, [
      placed[0]!.order.id,
    ]);
    await rpc('set_order_status', [
      company.id,
      placed[1]!.order.id,
      'pending',
      'preparing',
      now(),
      [],
    ]);
    await rpc('set_order_status', [
      company.id,
      placed[1]!.order.id,
      'preparing',
      'ready',
      now(),
      [],
    ]);
    expect(await rpc('order_status_counts', [company.id, false])).toEqual({
      pending: before.pending! + 1,
      preparing: before.preparing! + 1,
      ready: before.ready! + 1,
      out_for_delivery: before.out_for_delivery!,
    });
    // Sandbox chats are counted apart, as workspace_summary counts them.
    expect(await rpc('order_status_counts', [other.id, true])).toEqual({
      pending: 0,
      preparing: 0,
      ready: 0,
      out_for_delivery: 0,
    });
  });
  it('202610200003 moves older accepted orders, and their unsent notices, to preparing', async () => {
    const { conversation, order } = pendingOrder('whatsapp', '+923000000104');
    expect(await commit(conversation, order)).toBe(true);
    const old = { ...order, status: 'accepted' };
    await db.query(`update orders set data=$2 where id=$1`, [order.id, old]);
    const notice = {
      id: randomUUID(),
      companyId: company.id,
      kind: 'whatsapp_send',
      payload: { orderId: order.id, reference: order.reference, status: 'accepted' },
      status: 'pending',
      attempts: 0,
      nextRunAt: now(),
      createdAt: now(),
    };
    await rpc('insert_job', [notice]);
    // An order that already moved on keeps its old 'accepted' notice out of date, so a retry
    // never sends it late.
    const moved = pendingOrder('whatsapp', '+923000000105');
    expect(await commit(moved.conversation, moved.order)).toBe(true);
    await db.query(`update orders set data=$2 where id=$1`, [
      moved.order.id,
      { ...moved.order, status: 'preparing' },
    ]);
    const stale = {
      ...notice,
      id: randomUUID(),
      status: 'failed',
      payload: { orderId: moved.order.id, reference: moved.order.reference, status: 'accepted' },
    };
    await rpc('insert_job', [stale]);
    await db.exec(migrationSql('202610200003_order_flow.sql'));
    expect(await scalar(`select data as value from orders where id=$1`, [order.id])).toMatchObject({
      status: 'preparing',
      updatedAt: order.updatedAt,
    });
    expect(
      await scalar(`select data->'payload'->>'status' as value from jobs where id=$1`, [notice.id]),
    ).toBe('preparing');
    expect(
      await scalar(`select data->'payload'->>'status' as value from jobs where id=$1`, [stale.id]),
    ).toBe('accepted');
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

describe('spam protection', () => {
  const HOUR_START = "date_trunc('hour', now() at time zone 'UTC') at time zone 'UTC'";
  const MONTH_START = "date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'";
  const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
  const DENIED = /permission denied for (function|table)/;
  const hourStart = () => Math.floor(Date.now() / 3600000) * 3600000;
  const hourKey = () => new Date(hourStart()).toISOString().slice(0, 13);
  const nextHour = () => new Date(hourStart() + 3600000).toISOString();
  const monthKey = () => new Date().toISOString().slice(0, 7);
  const nextMonth = () => {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
  };
  const expiry = () => new Date(Date.now() + 60000).toISOString();
  // Calls with the named arguments the server sends, so a renamed SQL parameter fails here too.
  function named<T>(name: string, args: Record<string, unknown>) {
    const keys = Object.keys(args);
    return scalar(
      `select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(',')}) as value`,
      Object.values(args),
    ) as Promise<T>;
  }
  const reserve = (
    id: string,
    {
      conversationId,
      since,
      amount = 0.01,
      companyId = company.id,
    }: { conversationId?: string; since?: string; amount?: number; companyId?: string } = {},
  ) =>
    named<AiCallReservation>(
      'reserve_ai_call',
      reserveAiCallArgs(companyId, id, amount, expiry(), conversationId, since),
    );
  const block = (
    conversationId: string,
    blockId: string,
    keys: string[],
    { companyId = company.id, label = 'Spam sender' } = {},
  ) =>
    named<Conversation>(
      'block_customer',
      blockCustomerArgs(companyId, conversationId, blockId, keys, label, ownerId),
    );
  const hit = (keys: string[] | null, companyId = company.id) =>
    rpc('blocked_customer_hit', [companyId, keys]) as Promise<string | null>;
  // Settled AI calls. "at" is a SQL time, so a test can put them in an earlier hour or month.
  async function usage(
    count: number,
    {
      cost = 0.01,
      conversationId,
      sandbox,
      at = 'now()',
      companyId = company.id,
    }: {
      cost?: number;
      conversationId?: string;
      sandbox?: boolean;
      at?: string;
      companyId?: string;
    } = {},
  ) {
    const extra = {
      provider: 'openai',
      model: 'gpt-5.4-mini',
      inputTokens: 1,
      outputTokens: 1,
      ...(conversationId === undefined ? {} : { conversationId }),
      ...(sandbox === undefined ? {} : { sandbox }),
    };
    await db.query(
      `insert into usage_events(id,company_id,cost_usd,data,created_at)
       select $1::text||'-'||i, $2::text, $3::numeric, jsonb_build_object('id',$1::text||'-'||i,
         'companyId',$2::text,'costUsd',$3::numeric,'createdAt',${at})||$4::jsonb, ${at}
       from generate_series(1,$5::int) i`,
      [randomUUID(), companyId, cost, extra, count],
    );
  }
  const setLimits = (aiLimits: unknown, companyId = company.id) =>
    db.query("update companies set data=jsonb_set(data,'{aiLimits}',$2::jsonb) where id=$1", [
      companyId,
      JSON.stringify(aiLimits),
    ]);
  const setBudget = (usd: number) =>
    db.query(
      "update companies set data=jsonb_set(data,'{ai,monthlyBudgetUsd}',to_jsonb($2::numeric)) where id=$1",
      [company.id, usd],
    );
  async function hits(companyId = company.id) {
    return (
      await db.query<{
        scope: string;
        window_key: string;
        limit_value: number;
        resets_at: Date;
        first_hit_at: Date;
        last_hit_at: Date;
      }>(
        'select scope,window_key,limit_value::float8 as limit_value,resets_at,first_hit_at,last_hit_at from ai_limit_hits where company_id=$1 order by scope,window_key',
        [companyId],
      )
    ).rows;
  }
  const attention = (companyId = company.id) =>
    rpc('staff_attention', [companyId]) as Promise<StaffAttention>;
  async function whatsappChat(
    phone: string,
    extra: Partial<Conversation> = {},
    companyId = company.id,
  ) {
    const chat = {
      ...createConversation(companyId, phone, 'whatsapp', now()),
      ...extra,
      version: 1,
    };
    expect(await rpc('save_conversation', [chat, 0])).toBe(true);
    return chat;
  }
  async function stored(id: string) {
    return (
      await db.query<{ version: number; data: Conversation }>(
        'select version,data from conversations where id=$1',
        [id],
      )
    ).rows[0]!;
  }
  async function blockRows(companyId = company.id) {
    return (
      await db.query<{
        key: string;
        block_id: string;
        label: string;
        conversation_id: string | null;
        blocked_by: string | null;
        blocked_count: number;
        last_blocked_at: Date | null;
        created_at: Date;
      }>(
        'select key,block_id,label,conversation_id,blocked_by,blocked_count,last_blocked_at,created_at from blocked_customers where company_id=$1 order by key',
        [companyId],
      )
    ).rows;
  }

  beforeEach(async () => {
    // Counts by clock hour would straddle two hours if a test began in an hour's last seconds.
    const left = 3600000 - (Date.now() % 3600000);
    if (left < 5000) await new Promise((resolve) => setTimeout(resolve, left + 100));
  });

  it('reads the limits from settings, using the defaults for anything that is not a whole number in range', async () => {
    const settings = async (data: string | null) =>
      (
        await db.query<{ replies_per_hour: number; replies_per_customer: number }>(
          'select * from public.ai_limit_settings($1::jsonb)',
          [data],
        )
      ).rows[0];
    const expected = (perHour: number, perCustomer: number) => ({
      replies_per_hour: perHour,
      replies_per_customer: perCustomer,
    });
    const defaults = expected(
      AI_LIMIT_DEFAULTS.repliesPerHour,
      AI_LIMIT_DEFAULTS.repliesPerCustomerPerHour,
    );
    expect(defaults).toEqual(expected(1500, 100));
    expect(await settings(null)).toEqual(defaults);
    expect(await settings('null')).toEqual(defaults);
    expect(await settings(JSON.stringify(company))).toEqual(defaults);
    const [hourMin, hourMax] = AI_LIMIT_RANGES.repliesPerHour;
    const [customerMin, customerMax] = AI_LIMIT_RANGES.repliesPerCustomerPerHour;
    const cases: [unknown, ReturnType<typeof expected>][] = [
      [{ repliesPerHour: 120, repliesPerCustomerPerHour: 12 }, expected(120, 12)],
      [{ repliesPerHour: hourMin, repliesPerCustomerPerHour: customerMax }, expected(20, 1000)],
      [{ repliesPerHour: hourMax, repliesPerCustomerPerHour: customerMin }, expected(10000, 5)],
      [{ repliesPerHour: 120 }, expected(120, 100)],
      [{ repliesPerCustomerPerHour: 12 }, expected(1500, 12)],
    ];
    for (const bad of [
      '120',
      true,
      120.5,
      hourMin - 1,
      hourMax + 1,
      -120,
      0,
      1e30,
      null,
      [120],
      {},
    ])
      cases.push([{ repliesPerHour: bad, repliesPerCustomerPerHour: 12 }, expected(1500, 12)]);
    for (const bad of [
      '12',
      false,
      12.5,
      customerMin - 1,
      customerMax + 1,
      -12,
      0,
      1e30,
      null,
      [12],
    ])
      cases.push([{ repliesPerHour: 120, repliesPerCustomerPerHour: bad }, expected(120, 100)]);
    for (const bad of ['fast', 120, true, [120, 12], null]) cases.push([bad, defaults]);
    for (const [aiLimits, want] of cases) {
      expect(await settings(JSON.stringify({ aiLimits })), JSON.stringify(aiLimits)).toEqual(want);
      // The dashboard and the in-memory store read the same settings the same way.
      const app = effectiveAiLimits(aiLimits as Parameters<typeof effectiveAiLimits>[0]);
      expect(expected(app.repliesPerHour, app.repliesPerCustomerPerHour)).toEqual(want);
    }
    // Whole numbers written with a decimal point are still whole numbers.
    expect(
      await settings('{"aiLimits":{"repliesPerHour":120.0,"repliesPerCustomerPerHour":12.00}}'),
    ).toEqual(expected(120, 12));
    // A bad saved value never breaks AI calls, alerts or the status line.
    await setLimits({ repliesPerHour: 'lots', repliesPerCustomerPerHour: 1.5 });
    expect(await reserve('call', { conversationId: 'chat-1' })).toEqual({ ok: true });
    expect(await attention()).toMatchObject({ total: 0, limits: 0 });
    expect(await rpc('ai_limit_status', [company.id])).toMatchObject({
      repliesPerHour: 1500,
      repliesPerCustomerPerHour: 100,
    });
    await setLimits('lots');
    expect(await reserve('call-2', { conversationId: 'chat-1' })).toEqual({ ok: true });
  });

  it('reserves an AI call once, with the same checks as reserve_budget', async () => {
    expect(await reserve('call', { conversationId: 'chat-1', amount: 0.25 })).toEqual({ ok: true });
    expect(
      await scalar(
        'select amount_usd::float8 as value from budget_reservations where id=$1 and company_id=$2 and settled_at is null',
        ['call', company.id],
      ),
    ).toBe(0.25);
    expect(await reserve('call', { conversationId: 'chat-1' })).toEqual({
      ok: false,
      limit: 'duplicate',
    });
    await rpc('settle_budget', [
      'call',
      { id: 'call', companyId: company.id, costUsd: 0.2, createdAt: now() },
    ]);
    await db.query("delete from budget_reservations where id='call'");
    // A settled call's id stays taken.
    expect(await reserve('call')).toEqual({ ok: false, limit: 'duplicate' });
    await expect(reserve('negative', { amount: -1 })).rejects.toThrow('Invalid budget reservation');
    await expect(
      named(
        'reserve_ai_call',
        reserveAiCallArgs(company.id, 'expired', 0.01, new Date(Date.now() - 1000).toISOString()),
      ),
    ).rejects.toThrow('Invalid budget reservation');
    await expect(reserve('nobody', { companyId: 'missing' })).rejects.toThrow('Unknown company');
    await db.query(
      "update companies set data=jsonb_set(data,'{ai,monthlyBudgetUsd}','-1') where id=$1",
      [company.id],
    );
    await expect(reserve('bad-budget')).rejects.toThrow('Invalid company budget');
    expect(await hits()).toEqual([]);
  });

  it('stores prompt-cache token counts as sent and still counts the reply toward the limits', async () => {
    expect(await reserve('cached', { conversationId: 'chat-1' })).toEqual({ ok: true });
    await rpc('settle_budget', [
      'cached',
      {
        id: 'cached',
        companyId: company.id,
        provider: 'anthropic',
        model: 'claude-haiku-5-5',
        inputTokens: 4000,
        cacheReadTokens: 900,
        cacheWriteTokens: 100,
        outputTokens: 120,
        costUsd: 0.0002,
        createdAt: now(),
        conversationId: 'chat-1',
      },
    ]);
    const row = (
      await db.query<{ read: string; write: string; cost: number }>(
        "select data->>'cacheReadTokens' as read, data->>'cacheWriteTokens' as write, cost_usd::float8 as cost from usage_events where id='cached'",
      )
    ).rows[0];
    expect(row).toEqual({ read: '900', write: '100', cost: 0.0002 });
    expect(await rpc('ai_replies_this_hour', [company.id])).toBe(1);
  });

  it('refuses at the monthly budget like reserve_budget, says when it resets, and checks it first', async () => {
    const budget = company.ai.monthlyBudgetUsd;
    expect(budget).toBe(10);
    // Last month's spending and holds do not count.
    await usage(1, { cost: 50, at: `${MONTH_START} - interval '1 minute'` });
    expect(await reserve('last-month', { amount: 5 })).toEqual({ ok: true });
    await db.query(
      `update budget_reservations set created_at=${MONTH_START} - interval '1 minute' where id='last-month'`,
    );
    // This month: $0.50 spent, and a $9 call still running that may already have cost money.
    await usage(1, { cost: 0.5 });
    await usage(3, { cost: 1, companyId: other.id });
    expect(await reserve('running', { amount: 9 })).toEqual({ ok: true });
    const results: [boolean, boolean][] = [];
    for (const amount of [0.49, 0.5, 0.51]) {
      const legacy = (await rpc('reserve_budget', [
        company.id,
        `legacy-${amount}`,
        amount,
        expiry(),
      ])) as boolean;
      await db.query('delete from budget_reservations where id=$1', [`legacy-${amount}`]);
      const result = await reserve(`new-${amount}`, { amount, conversationId: 'chat-1' });
      await db.query('delete from budget_reservations where id=$1', [`new-${amount}`]);
      results.push([legacy, result.ok]);
    }
    expect(results).toEqual([
      [true, true],
      [true, true],
      [false, false],
    ]);
    const refusal = await reserve('over', { amount: 0.51, conversationId: 'chat-1' });
    expect(refusal).toEqual({
      ok: false,
      limit: 'monthly',
      limitValue: budget,
      resetAt: nextMonth(),
    });
    expect(
      await scalar("select count(*)::int as value from budget_reservations where id='over'"),
    ).toBe(0);
    // Both refusals this month share one row.
    expect(await hits()).toEqual([
      {
        scope: 'monthly',
        window_key: monthKey(),
        limit_value: budget,
        resets_at: new Date(nextMonth()),
        first_hit_at: expect.any(Date),
        last_hit_at: expect.any(Date),
      },
    ]);
    // With the hourly and the customer limits also reached, the monthly one is what is reported.
    await setLimits({ repliesPerHour: 20, repliesPerCustomerPerHour: 5 });
    await usage(20, { cost: 0.000001, conversationId: 'chat-1' });
    expect(await reserve('all-limits', { amount: 0.51, conversationId: 'chat-1' })).toMatchObject({
      limit: 'monthly',
    });
    // Within the budget, the hourly limit comes before the customer's own.
    expect(
      await reserve('hour-and-customer', { amount: 0.000001, conversationId: 'chat-1' }),
    ).toMatchObject({ limit: 'hourly' });
  });

  it('refuses live chat replies at the hourly limit until the next clock hour', async () => {
    await setLimits({ repliesPerHour: 20, repliesPerCustomerPerHour: 1000 });
    await usage(18);
    await usage(1, { sandbox: false, conversationId: 'chat-1' });
    // Not replies: test chats, calls the provider refused, the previous hour, another business.
    await usage(10, { sandbox: true });
    await usage(10, { cost: 0 });
    await usage(10, { at: `${HOUR_START} - interval '1 second'` });
    await usage(30, { companyId: other.id });
    expect(await reserve('20th', { conversationId: 'chat-1' })).toEqual({ ok: true });
    // A live call still running counts too, so many numbers writing at once cannot all pass.
    const refusal = await reserve('21st', { conversationId: 'chat-2' });
    expect(refusal).toEqual({ ok: false, limit: 'hourly', limitValue: 20, resetAt: nextHour() });
    expect(
      await scalar("select count(*)::int as value from budget_reservations where id='21st'"),
    ).toBe(0);
    expect(await hits()).toEqual([
      {
        scope: 'hourly',
        window_key: hourKey(),
        limit_value: 20,
        resets_at: new Date(nextHour()),
        first_hit_at: expect.any(Date),
        last_hit_at: expect.any(Date),
      },
    ]);
    // Test chats and model checks (no conversation) keep only the monthly budget.
    expect(await reserve('test-chat')).toEqual({ ok: true });
    // The other business counts only its own replies.
    expect(await reserve('other', { conversationId: 'chat-x', companyId: other.id })).toEqual({
      ok: true,
    });
    expect(await hits(other.id)).toEqual([]);
    // A running call the provider then refused settles at $0 and stops counting.
    await rpc('settle_budget', [
      '20th',
      {
        id: '20th',
        companyId: company.id,
        provider: 'openai',
        model: 'gpt-5.4-mini',
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        createdAt: new Date().toISOString(),
        conversationId: 'chat-1',
        rejected: true,
      },
    ]);
    expect(await reserve('after-refusal', { conversationId: 'chat-2' })).toEqual({ ok: true });
    // A live call left behind by a killed worker stops counting once its hold expires.
    await db.exec(
      "update budget_reservations set expires_at=now()-interval '1 second' where id='after-refusal'",
    );
    expect(await reserve('after-expiry', { conversationId: 'chat-3' })).toEqual({ ok: true });
    // Raising the limit lets replies through straight away.
    await setLimits({ repliesPerHour: 21, repliesPerCustomerPerHour: 1000 });
    expect(await reserve('raised', { conversationId: 'chat-4' })).toEqual({ ok: true });
    expect(await reserve('over-again', { conversationId: 'chat-5' })).toMatchObject({
      limit: 'hourly',
    });
  });

  it('refuses one customer at their own limit, counting from the later of an hour ago and the bot taking the chat back', async () => {
    await setLimits({ repliesPerHour: 10000, repliesPerCustomerPerHour: 5 });
    await usage(4, { conversationId: 'chat-1', at: "now() - interval '59 minutes'" });
    // Not counted: over an hour ago, refused by the provider, other chats, no chat at all.
    await usage(10, { conversationId: 'chat-1', at: "now() - interval '61 minutes'" });
    await usage(10, { conversationId: 'chat-1', cost: 0 });
    await usage(10, { conversationId: 'chat-2' });
    await usage(10);
    await usage(10, { conversationId: 'chat-1', companyId: other.id });
    expect(await reserve('a', { conversationId: 'chat-1' })).toEqual({ ok: true });
    await usage(1, { conversationId: 'chat-1' });
    const before = Date.now();
    const refusal = await reserve('b', { conversationId: 'chat-1' });
    expect(refusal).toEqual({
      ok: false,
      limit: 'customer',
      limitValue: 5,
      resetAt: expect.stringMatching(ISO),
    });
    const resetAt = Date.parse((refusal as { resetAt: string }).resetAt);
    expect(resetAt).toBeGreaterThanOrEqual(before + 3600000 - 1);
    expect(resetAt).toBeLessThanOrEqual(Date.now() + 3600000);
    // Unlike the limits for the whole business, one customer's limit does not ring the bell.
    expect(await hits()).toEqual([]);
    expect(await reserve('other-customer', { conversationId: 'chat-3' })).toEqual({ ok: true });
    expect(await reserve('no-chat')).toEqual({ ok: true });
    expect(
      await reserve('other-business', { conversationId: 'chat-1', companyId: other.id }),
    ).toEqual({ ok: true });
    // When the bot takes the chat back, the customer starts again with a full allowance...
    const resumed = new Date().toISOString();
    expect(await reserve('c', { conversationId: 'chat-1', since: resumed })).toEqual({ ok: true });
    // ...and the replies after that count.
    await usage(5, { conversationId: 'chat-1' });
    expect(await reserve('d', { conversationId: 'chat-1', since: resumed })).toMatchObject({
      limit: 'customer',
    });
    // A resume time long ago does not reach back past the hour.
    await usage(10, { conversationId: 'chat-4', at: "now() - interval '2 hours'" });
    expect(
      await reserve('e', {
        conversationId: 'chat-4',
        since: new Date(Date.now() - 3 * 3600000).toISOString(),
      }),
    ).toEqual({ ok: true });
    // A resume time ahead of the database clock counts from now, so replies stamped by a server
    // clock that runs slightly ahead still count.
    await usage(5, { conversationId: 'chat-5', at: "now() + interval '1 minute'" });
    expect(
      await reserve('f', {
        conversationId: 'chat-5',
        since: new Date(Date.now() + 86400000).toISOString(),
      }),
    ).toMatchObject({ limit: 'customer' });
  });

  it('keeps one limit hit per window, updating it on each refusal, and prunes hits over 40 days old', async () => {
    const old = "now() - interval '41 days'";
    const recent = "now() - interval '39 days'";
    await db.query(
      `insert into ai_limit_hits(company_id,scope,window_key,limit_value,resets_at,first_hit_at,last_hit_at) values
        ($1,'hourly','old',20,${old},${old},${old}),
        ($1,'monthly','recent',10,${recent},${recent},${recent}),
        ($2,'hourly','other-old',20,${old},${old},${old})`,
      [company.id, other.id],
    );
    await setLimits({ repliesPerHour: 20 });
    await usage(20);
    expect(await reserve('a', { conversationId: 'chat-1' })).toMatchObject({ limit: 'hourly' });
    expect((await hits()).map((h) => h.window_key)).toEqual([hourKey(), 'recent']);
    // Each business prunes only its own.
    expect((await hits(other.id)).map((h) => h.window_key)).toEqual(['other-old']);
    await db.query(
      "update ai_limit_hits set last_hit_at=now()-interval '10 minutes',resets_at=resets_at-interval '1 minute' where window_key=$1",
      [hourKey()],
    );
    const first = (await hits()).find((h) => h.scope === 'hourly')!;
    // A lower limit later in the same hour updates the same row.
    await setLimits({ repliesPerHour: 25 });
    await usage(5);
    expect(await reserve('b', { conversationId: 'chat-1' })).toMatchObject({
      limit: 'hourly',
      limitValue: 25,
    });
    const hourly = (await hits()).filter((h) => h.scope === 'hourly');
    expect(hourly).toHaveLength(1);
    expect(hourly[0]).toEqual({
      ...first,
      limit_value: 25,
      resets_at: new Date(nextHour()),
      last_hit_at: expect.any(Date),
    });
    expect(hourly[0].last_hit_at.getTime()).toBeGreaterThan(Date.now() - 60000);
  });

  it('shows a reached hourly limit in the bell until the hour ends or the limit is raised', async () => {
    await setLimits({ repliesPerHour: 20 });
    await usage(20);
    await reserve('a', { conversationId: 'chat-1' });
    const alerts = await attention();
    expect(alerts).toMatchObject({ total: 1, limits: 1, budgets: 0, orders: 0 });
    expect(alerts.items).toEqual([
      {
        id: `limit:hourly:${hourKey()}`,
        kind: 'limit',
        entityId: company.id,
        createdAt: expect.any(String),
        scope: 'hourly',
        resetsAt: expect.any(String),
      },
    ]);
    expect(Date.parse(alerts.items[0].resetsAt!)).toBe(hourStart() + 3600000);
    expect(Date.parse(alerts.items[0].createdAt)).toBeLessThanOrEqual(Date.now());
    expect(await attention(other.id)).toMatchObject({ total: 0, limits: 0, items: [] });
    await setLimits({ repliesPerHour: 21 });
    expect(await attention()).toMatchObject({ total: 0, limits: 0, items: [] });
    // Lowering it back shows the limit reached again; an unreadable setting means the default 1,500.
    await setLimits({ repliesPerHour: 20 });
    expect(await attention()).toMatchObject({ total: 1, limits: 1 });
    await setLimits({ repliesPerHour: '20' });
    expect(await attention()).toMatchObject({ total: 0, limits: 0 });
    await setLimits({ repliesPerHour: 20 });
    await db.query("update ai_limit_hits set resets_at=now()-interval '1 second'");
    expect(await attention()).toMatchObject({ total: 0, limits: 0, items: [] });
  });

  it('replaces the 80% budget warning with the reached monthly limit until the budget is raised', async () => {
    expect(await reserve('running', { amount: 9 })).toEqual({ ok: true });
    expect(await attention()).toMatchObject({ total: 1, budgets: 1, limits: 0 });
    expect(await reserve('over', { amount: 2, conversationId: 'chat-1' })).toMatchObject({
      limit: 'monthly',
    });
    const alerts = await attention();
    expect(alerts).toMatchObject({ total: 1, budgets: 0, limits: 1 });
    expect(alerts.items).toEqual([
      {
        id: `limit:monthly:${monthKey()}`,
        kind: 'limit',
        entityId: company.id,
        createdAt: expect.any(String),
        scope: 'monthly',
        resetsAt: expect.any(String),
      },
    ]);
    expect(Date.parse(alerts.items[0].resetsAt!)).toBe(Date.parse(nextMonth()));
    // $9 of $11 is still over 80%, so the warning comes back in its place.
    await setBudget(11);
    expect(await attention()).toMatchObject({ total: 1, budgets: 1, limits: 0 });
    await setBudget(20);
    expect(await attention()).toMatchObject({ total: 0, budgets: 0, limits: 0 });
    await setBudget(10);
    expect(await attention()).toMatchObject({ total: 1, budgets: 0, limits: 1 });
    await db.query("update ai_limit_hits set resets_at=now()-interval '1 second'");
    expect(await attention()).toMatchObject({ total: 1, budgets: 1, limits: 0 });
  });

  it('keeps the order, handoff, job and budget items exactly as before', async () => {
    const { conversation, order } = pendingOrder();
    await commit(conversation, order);
    await db.query(
      "update conversations set data=jsonb_set(data,'{mode}','\"human\"') where id=$1",
      [conversation.id],
    );
    await rpc('insert_job', [
      { ...makeJob(company.id, 'sheet_sync', { orderId: order.id }), status: 'failed' },
    ]);
    await reserve('running', { amount: 9 });
    const alerts = await attention();
    expect(alerts).toMatchObject({
      total: 4,
      orders: 1,
      handoffs: 1,
      failures: 1,
      budgets: 1,
      limits: 0,
    });
    expect(alerts.items.map((item) => item.kind).sort()).toEqual([
      'budget',
      'handoff',
      'job',
      'order',
    ]);
    for (const item of alerts.items)
      expect(Object.keys(item).sort()).toEqual(['createdAt', 'entityId', 'id', 'kind']);
    expect(alerts.items.find((item) => item.kind === 'budget')!.id).toBe(
      `budget:${company.id}:${monthKey()}`,
    );
  });

  it('asks for an email alert while a limit was reached within the last hour', async () => {
    await db.query("insert into company_memberships values($1,$2,'staff')", [company.id, ownerId]);
    await db.query(
      "update auth.users set email='staff@example.test',email_confirmed_at=now() where id=$1",
      [ownerId],
    );
    await rpc('configure_alerts', [company.id, ownerId, true, 10]);
    expect(await rpc('has_overdue_attention', [company.id, 10])).toBe(false);
    expect(await rpc('queue_staff_alerts', [])).toBe(0);
    await setLimits({ repliesPerHour: 20 });
    await usage(20);
    await reserve('a', { conversationId: 'chat-1' });
    expect(await rpc('has_overdue_attention', [company.id, 10])).toBe(true);
    expect(await rpc('has_overdue_attention', [other.id, 10])).toBe(false);
    expect(await rpc('queue_staff_alerts', [])).toBe(1);
    await db.query("update ai_limit_hits set last_hit_at=now()-interval '59 minutes'");
    expect(await rpc('has_overdue_attention', [company.id, 10])).toBe(true);
    await db.query("update ai_limit_hits set last_hit_at=now()-interval '61 minutes'");
    expect(await rpc('has_overdue_attention', [company.id, 10])).toBe(false);
  });

  it('reports this hour’s live AI replies and the limits in force', async () => {
    await setLimits({ repliesPerHour: 50, repliesPerCustomerPerHour: 10 });
    await usage(3);
    await usage(1, { conversationId: 'chat-1', sandbox: false });
    await usage(2, { sandbox: true });
    await usage(2, { cost: 0 });
    await usage(2, { at: `${HOUR_START} - interval '1 second'` });
    await usage(5, { companyId: other.id });
    expect(await rpc('ai_limit_status', [company.id])).toEqual<AiLimitStatus>({
      repliesThisHour: 4,
      repliesPerHour: 50,
      repliesPerCustomerPerHour: 10,
      hourResetsAt: nextHour(),
    });
    expect(await rpc('ai_limit_status', [other.id])).toEqual<AiLimitStatus>({
      repliesThisHour: 5,
      repliesPerHour: AI_LIMIT_DEFAULTS.repliesPerHour,
      repliesPerCustomerPerHour: AI_LIMIT_DEFAULTS.repliesPerCustomerPerHour,
      hourResetsAt: nextHour(),
    });
    expect(await rpc('ai_limit_status', ['missing'])).toBeNull();
  });

  it('blocks a customer’s keys and marks their chat in one step', async () => {
    const chat = await whatsappChat('+923001234567', {
      mode: 'human',
      botPausedAt: now(),
      limitPause: { reason: 'customer', at: now(), until: now(), limit: 30 },
    });
    const demo = { ...createConversation(company.id, '+923001234567', 'demo', now()), version: 1 };
    await rpc('save_conversation', [demo, 0]);
    const phone = 'pn:923001234567';
    await expect(block(chat.id, 'block-1', [])).rejects.toThrow('Nothing to block');
    await expect(block(chat.id, '', [phone])).rejects.toThrow('Nothing to block');
    for (const keys of [
      ['923001234567'],
      ['pn:+923001234567'],
      ['pn:1234'],
      ['pn:123456789012345678901'],
      ['tel:923001234567'],
      ['lid:100000001@lid'],
      [phone, 'junk'],
    ])
      await expect(block(chat.id, 'block-1', keys), keys.join()).rejects.toThrow(
        'Invalid block key',
      );
    await expect(block('missing', 'block-1', [phone])).rejects.toThrow('Unknown conversation');
    await expect(block(chat.id, 'block-1', [phone], { companyId: other.id })).rejects.toThrow(
      'Unknown conversation',
    );
    await expect(block(demo.id, 'block-1', [phone])).rejects.toThrow(
      'Only WhatsApp chats can be blocked',
    );
    expect(await blockRows()).toEqual([]);
    expect((await stored(chat.id)).version).toBe(1);

    const result = await block(chat.id, 'block-1', [phone, 'lid:100000001', phone], {
      label: 'x'.repeat(250),
    });
    const {
      botPausedAt: _paused,
      limitPause: _limit,
      ...rest
    } = JSON.parse(JSON.stringify(chat)) as Conversation;
    expect(result).toEqual({
      ...rest,
      mode: 'bot',
      version: 2,
      updatedAt: result.blocked!.at,
      blocked: { at: expect.stringMatching(ISO), blockId: 'block-1' },
    });
    expect(Math.abs(Date.parse(result.blocked!.at) - Date.now())).toBeLessThan(60000);
    expect(await stored(chat.id)).toEqual({ version: 2, data: result });
    expect(await blockRows()).toEqual(
      ['lid:100000001', phone].map((key) => ({
        key,
        block_id: 'block-1',
        label: 'x'.repeat(200),
        conversation_id: chat.id,
        blocked_by: ownerId,
        blocked_count: 0,
        last_blocked_at: null,
        created_at: expect.any(Date),
      })),
    );
    // Blocking an already blocked chat changes nothing.
    expect(await block(chat.id, 'block-2', ['pn:923009999999'])).toEqual(result);
    expect(await stored(chat.id)).toEqual({ version: 2, data: result });
    expect((await blockRows()).map((row) => row.block_id)).toEqual(['block-1', 'block-1']);
  });

  it('keeps one block per person, joining and merging blocks that share an identity', async () => {
    const first = await whatsappChat('+923001111111');
    const second = await whatsappChat('+923002222222');
    const third = await whatsappChat('+923003333333');
    await block(first.id, 'block-a', ['pn:923001111111', 'lid:100000001']);
    await block(third.id, 'block-c', ['pn:923003333333']);
    await db.query(
      "update blocked_customers set created_at=now()-interval '1 day' where block_id='block-a'",
    );
    // The same person again, under a new number with the same privacy ID, and sharing the
    // third chat's number: the newest block takes them all.
    const result = await block(
      second.id,
      'block-b',
      ['pn:923002222222', 'lid:100000001', 'pn:923003333333'],
      { label: 'Again' },
    );
    expect(result.blocked).toMatchObject({ blockId: 'block-c' });
    expect(
      (await blockRows()).map((row) => [row.key, row.block_id, row.conversation_id, row.label]),
    ).toEqual([
      ['lid:100000001', 'block-c', first.id, 'Spam sender'],
      ['pn:923001111111', 'block-c', first.id, 'Spam sender'],
      ['pn:923002222222', 'block-c', second.id, 'Again'],
      ['pn:923003333333', 'block-c', third.id, 'Spam sender'],
    ]);
    const repointed = await stored(first.id);
    expect(repointed.version).toBe(3);
    expect(repointed.data.version).toBe(3);
    expect(repointed.data.blocked).toMatchObject({ blockId: 'block-c' });
    expect((await stored(third.id)).version).toBe(2);
    expect(await hit(['lid:100000001'])).toBe('block-c');
    expect(
      ((await rpc('list_blocked_customers', [company.id])) as BlockedCustomer[]).map(
        (b) => b.blockId,
      ),
    ).toEqual(['block-c']);
    // Unblocking the one block unblocks the person in every chat.
    expect(await rpc('unblock_customer', [company.id, 'block-c'])).toBe(true);
    expect(await blockRows()).toEqual([]);
    for (const chat of [first, second, third])
      expect((await stored(chat.id)).data).not.toHaveProperty('blocked');
  });

  it('unblocks atomically, also clearing chats whose block lost all its keys', async () => {
    const first = await whatsappChat('+923001111111');
    const second = await whatsappChat('+923002222222');
    const outside = await whatsappChat('+923001111111', {}, other.id);
    await block(first.id, 'block-a', ['pn:923001111111']);
    await block(outside.id, 'block-o', ['pn:923001111111'], { companyId: other.id });
    expect(await rpc('unblock_customer', [company.id, 'missing'])).toBe(false);
    expect(await rpc('unblock_customer', [company.id, 'block-o'])).toBe(false);
    expect(await rpc('unblock_customer', [other.id, 'block-a'])).toBe(false);
    expect((await stored(first.id)).version).toBe(2);
    expect((await blockRows()).map((row) => row.block_id)).toEqual(['block-a']);

    expect(await rpc('unblock_customer', [company.id, 'block-a'])).toBe(true);
    expect(await blockRows()).toEqual([]);
    const unblocked = await stored(first.id);
    expect(unblocked.version).toBe(3);
    expect(unblocked.data.version).toBe(3);
    expect(unblocked.data).not.toHaveProperty('blocked');
    expect(unblocked.data.updatedAt).toMatch(ISO);
    expect(await rpc('unblock_customer', [company.id, 'block-a'])).toBe(false);
    expect((await stored(outside.id)).data.blocked).toMatchObject({ blockId: 'block-o' });
    expect((await blockRows(other.id)).map((row) => row.block_id)).toEqual(['block-o']);

    // A later block of the same person joins the earlier one, so either chat's mark unblocks
    // the person and clears both chats.
    await block(first.id, 'block-c', ['lid:100000001']);
    await block(second.id, 'block-d', ['lid:100000001', 'pn:923002222222']);
    expect(
      ((await rpc('list_blocked_customers', [company.id])) as BlockedCustomer[]).map(
        (b) => b.blockId,
      ),
    ).toEqual(['block-c']);
    expect((await stored(second.id)).data.blocked).toMatchObject({ blockId: 'block-c' });
    expect(await rpc('unblock_customer', [company.id, 'block-c'])).toBe(true);
    for (const [id, version] of [
      [first.id, 5],
      [second.id, 3],
    ] as const) {
      const chat = await stored(id);
      expect(chat.version).toBe(version);
      expect(chat.data.version).toBe(version);
      expect(chat.data).not.toHaveProperty('blocked');
    }
    expect(await blockRows()).toEqual([]);
    // A mark whose block has no rows any more (never written by these functions) is cleared
    // by the next unblock.
    await db.query(
      `update conversations set data=jsonb_set(data,'{blocked}','{"at":"2026-10-16T10:00:00.000Z","blockId":"gone"}') where id=$1`,
      [first.id],
    );
    expect(await rpc('unblock_customer', [company.id, 'gone'])).toBe(true);
    expect((await stored(first.id)).data).not.toHaveProperty('blocked');
  });

  it('drops a blocked customer’s messages by phone or privacy ID, learning new identities', async () => {
    const chat = await whatsappChat('+923001234567');
    const outside = await whatsappChat('+923007654321', {}, other.id);
    await block(chat.id, 'block-1', ['pn:923001234567']);
    await block(outside.id, 'block-o', ['lid:100000009'], { companyId: other.id });
    expect(await hit([])).toBeNull();
    expect(await hit(null)).toBeNull();
    expect(await hit(['pn:923009999999'])).toBeNull();
    expect(await hit(['lid:100000009'])).toBeNull();
    expect(await hit(['pn:923001234567'], other.id)).toBeNull();
    expect(await hit(['pn:923001234567'])).toBe('block-1');
    // A message carrying the phone and a privacy ID: one count, and the ID joins the block.
    expect(await hit(['lid:100000001', 'pn:923001234567', 'lid:100000001', 'junk'])).toBe(
      'block-1',
    );
    let rows = await blockRows();
    expect(rows.map((row) => [row.key, row.block_id, row.blocked_count])).toEqual([
      ['lid:100000001', 'block-1', 0],
      ['pn:923001234567', 'block-1', 2],
    ]);
    expect(rows[0]).toMatchObject({
      label: rows[1].label,
      conversation_id: chat.id,
      blocked_by: ownerId,
      created_at: rows[1].created_at,
      last_blocked_at: null,
    });
    expect(rows[1].last_blocked_at!.getTime()).toBeGreaterThan(Date.now() - 60000);
    // The privacy ID alone is now enough.
    expect(await hit(['lid:100000001'])).toBe('block-1');
    rows = await blockRows();
    expect(rows.reduce((sum, row) => sum + row.blocked_count, 0)).toBe(3);
    expect((await blockRows(other.id)).map((row) => [row.key, row.blocked_count])).toEqual([
      ['lid:100000009', 0],
    ]);
  });

  it('lists blocks newest first with their keys and ignored-message counts', async () => {
    const a = await whatsappChat('+923001111111');
    const b = await whatsappChat('+923002222222');
    const outside = await whatsappChat('+923001111111', {}, other.id);
    await block(a.id, 'block-a', ['pn:923001111111', 'lid:100000001'], { label: 'First' });
    await db.query("update blocked_customers set created_at=now()-interval '1 day'");
    await block(b.id, 'block-b', ['pn:923002222222'], { label: 'Second' });
    await block(outside.id, 'block-o', ['pn:923001111111'], { companyId: other.id });
    await hit(['pn:923001111111']);
    await hit(['pn:923001111111']);
    await hit(['lid:100000001']);
    const list = (await rpc('list_blocked_customers', [company.id])) as BlockedCustomer[];
    expect(list).toEqual([
      {
        blockId: 'block-b',
        label: 'Second',
        keys: ['pn:923002222222'],
        conversationId: b.id,
        blockedBy: ownerId,
        createdAt: expect.stringMatching(ISO),
        blockedCount: 0,
      },
      {
        blockId: 'block-a',
        label: 'First',
        keys: ['lid:100000001', 'pn:923001111111'],
        conversationId: a.id,
        blockedBy: ownerId,
        createdAt: expect.stringMatching(ISO),
        blockedCount: 3,
        lastBlockedAt: expect.stringMatching(ISO),
      },
    ]);
    expect(Date.now() - Date.parse(list[1].createdAt)).toBeGreaterThan(86400000 - 60000);
    expect(Date.now() - Date.parse(list[1].lastBlockedAt!)).toBeLessThan(60000);
    expect(await rpc('list_blocked_customers', [other.id])).toEqual([
      expect.objectContaining({ blockId: 'block-o', keys: ['pn:923001111111'], blockedCount: 0 }),
    ]);
    expect(await rpc('list_blocked_customers', ['missing'])).toEqual([]);
  });

  it.each(['anon', 'authenticated'])(
    'denies %s every spam protection function and table',
    async (role) => {
      const calls: [string, unknown[]][] = [
        ['ai_limit_value', ['20', 5, 1000, 30]],
        ['ai_limit_settings', ['{}']],
        ['record_ai_limit_hit', [company.id, 'hourly', 'x', 20, expiry()]],
        ['ai_limit_status', [company.id]],
        ['ai_replies_this_hour', [company.id]],
        ['fail_exhausted_orderly_jobs', [20]],
        ['unblock_customer', [company.id, 'block-1']],
        ['blocked_customer_hit', [company.id, ['pn:923001234567']]],
        ['list_blocked_customers', [company.id]],
        ['staff_attention', [company.id]],
        ['has_overdue_attention', [company.id, 10]],
      ];
      await db.exec(`set role ${role}`);
      try {
        for (const [name, args] of calls)
          await expect(rpc(name, args), name).rejects.toThrow(DENIED);
        await expect(reserve('browser', { conversationId: 'chat-1' })).rejects.toThrow(DENIED);
        await expect(block('chat-1', 'block-1', ['pn:923001234567'])).rejects.toThrow(DENIED);
        for (const table of ['ai_limit_hits', 'blocked_customers']) {
          await expect(db.query(`select * from public.${table}`), table).rejects.toThrow(DENIED);
          await expect(db.query(`delete from public.${table}`), table).rejects.toThrow(DENIED);
        }
      } finally {
        await db.exec('reset role');
      }
    },
  );

  it('lets the server role use them', async () => {
    const chat = await whatsappChat('+923001234567');
    await db.exec('set role service_role');
    try {
      expect(
        await scalar("select replies_per_hour as value from public.ai_limit_settings('{}')"),
      ).toBe(1500);
      expect(await reserve('server', { conversationId: chat.id })).toEqual({ ok: true });
      expect(await block(chat.id, 'block-1', ['pn:923001234567'])).toMatchObject({
        blocked: { blockId: 'block-1' },
      });
      expect(await hit(['pn:923001234567'])).toBe('block-1');
      expect(await rpc('list_blocked_customers', [company.id])).toHaveLength(1);
      // The reply reserved above is still running, and it counts.
      expect(await rpc('ai_limit_status', [company.id])).toMatchObject({ repliesThisHour: 1 });
      expect(await rpc('unblock_customer', [company.id, 'block-1'])).toBe(true);
      expect(await scalar('select count(*)::int as value from public.ai_limit_hits')).toBe(0);
      expect(await rpc('fail_exhausted_orderly_jobs', [20])).toBe(0);
    } finally {
      await db.exec('reset role');
    }
  });

  it('fails an exhausted message like the worker does: pause cleared, blocked chats left alone', async () => {
    const pause = {
      reason: 'customer',
      at: now(),
      until: new Date(Date.now() + 3600000).toISOString(),
      limit: 30,
    } as const;
    const paused = await whatsappChat('+923001111111', { mode: 'human', limitPause: pause });
    const spam = await whatsappChat('+923002222222');
    await block(spam.id, 'block-1', ['pn:923002222222']);
    const bystander = await whatsappChat('+923003333333', { mode: 'human', limitPause: pause });
    for (const phone of ['+923001111111', '+923002222222'])
      await rpc('insert_job', [
        {
          ...makeJob(company.id, 'incoming', { phone, messageId: randomUUID(), text: 'hi' }),
          status: 'processing',
          attempts: 5,
          leaseUntil: new Date(Date.now() - 60000).toISOString(),
        },
      ]);
    await db.exec("update jobs set lease_until=now()-interval '1 minute'");
    expect(await rpc('fail_exhausted_orderly_jobs', [20])).toBe(2);
    const failed = await stored(paused.id);
    expect(failed.version).toBe(2);
    expect(failed.data).toMatchObject({ mode: 'human', version: 2 });
    expect(failed.data).not.toHaveProperty('limitPause');
    const blocked = await stored(spam.id);
    expect(blocked.version).toBe(2);
    expect(blocked.data).toMatchObject({ mode: 'bot', blocked: { blockId: 'block-1' } });
    expect((await stored(bystander.id)).data.limitPause).toEqual(pause);
  });

  it('never asks staff about a blocked number', async () => {
    const chat = await whatsappChat('+923001111111', {
      mode: 'human',
      messages: [{ id: 'm1', role: 'customer', text: 'spam', createdAt: now() }],
    });
    await db.exec("update conversations set updated_at=now()-interval '1 hour'");
    expect(await attention()).toMatchObject({ handoffs: 1 });
    expect(await rpc('has_overdue_attention', [company.id, 10])).toBe(true);
    // A blocked chat that ended up with staff (for example after a failed job) stays quiet.
    await db.query(
      `update conversations set data=jsonb_set(data,'{blocked}','{"at":"2026-10-16T10:00:00.000Z","blockId":"b"}') where id=$1`,
      [chat.id],
    );
    expect(await attention()).toMatchObject({ handoffs: 0 });
    expect(await rpc('has_overdue_attention', [company.id, 10])).toBe(false);
  });

  it('refuses to be applied again once superseded, without losing limits or blocks', async () => {
    const chat = await whatsappChat('+923001234567');
    await block(chat.id, 'block-1', ['pn:923001234567']);
    await hit(['pn:923001234567', 'lid:100000001']);
    await setLimits({ repliesPerHour: 20 });
    await usage(20);
    await reserve('a', { conversationId: 'chat-1' });
    const snapshot = async () => ({
      list: await rpc('list_blocked_customers', [company.id]),
      hits: await hits(),
      chat: await stored(chat.id),
      attention: await attention(),
      status: await rpc('ai_limit_status', [company.id]),
    });
    const before = await snapshot();
    expect(before.hits).toHaveLength(1);
    // 202610200001 replaced its attention functions and defaults: a rerun would put them back.
    await expect(
      db.exec(readFileSync('supabase/migrations/202610180001_spam_protection.sql', 'utf8')),
    ).rejects.toThrow('superseded by 202610200001_prelaunch_fixes.sql');
    expect(await snapshot()).toEqual(before);
    expect(await hit(['lid:100000001'])).toBe('block-1');
    await db.exec('set role authenticated');
    try {
      await expect(rpc('list_blocked_customers', [company.id])).rejects.toThrow(DENIED);
      await expect(reserve('browser')).rejects.toThrow(DENIED);
    } finally {
      await db.exec('reset role');
    }
  });
});

describe('menu page', () => {
  const DENIED = /permission denied for (function|table)/;
  const link = (companyId: string, enabled: boolean, slug: string) =>
    scalar(
      'select public.set_menu_link(p_company_id => $1, p_enabled => $2, p_slug => $3) as value',
      [companyId, enabled, slug],
    ) as Promise<{ companyId: string; slug: string; enabled: boolean; updatedAt: string }>;

  it('chooses the slug once, numbers a taken one, and keeps it when switched off and on', async () => {
    const first = await link(company.id, true, 'laziza');
    expect(first).toMatchObject({ companyId: company.id, slug: 'laziza', enabled: true });
    expect(first.updatedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(await link(other.id, true, 'laziza')).toMatchObject({ slug: 'laziza-2' });
    expect(await link(company.id, false, 'renamed-business')).toMatchObject({
      slug: 'laziza',
      enabled: false,
    });
    expect(await link(company.id, true, 'renamed-business')).toMatchObject({
      slug: 'laziza',
      enabled: true,
    });
    await expect(link(randomUUID(), true, 'nobody')).rejects.toThrow('Unknown company');
    await db.query('delete from menu_links');
    await expect(link(company.id, true, 'Bad Slug')).rejects.toThrow('Invalid menu link');
    await expect(link(company.id, true, 'ab')).rejects.toThrow('Invalid menu link');
  });

  it('is server-only and can be applied again without changing links', async () => {
    await link(company.id, true, 'laziza');
    await db.exec(readFileSync('supabase/migrations/202610190001_menu_page.sql', 'utf8'));
    expect(
      await scalar('select slug value from menu_links where company_id=$1', [company.id]),
    ).toBe('laziza');
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      try {
        await expect(link(company.id, false, 'laziza')).rejects.toThrow(DENIED);
        await expect(db.query('select * from menu_links')).rejects.toThrow(DENIED);
      } finally {
        await db.exec('reset role');
      }
    }
  });
});

describe('menu page ordering', () => {
  const DENIED = /permission denied for (function|table)/;
  const phone = '+923001112222';
  const cart: WebCart = {
    items: [{ productId: products[0]!.id, quantity: 2, modifierIds: [], notes: '' }],
    fulfillment: 'pickup',
    customerName: 'Ali',
  };
  function named<T>(name: string, args: Record<string, unknown>) {
    const keys = Object.keys(args);
    return scalar(
      `select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(',')}) as value`,
      Object.values(args),
    ) as Promise<T>;
  }
  async function chat(customerPhone = phone, changes: Partial<Conversation> = {}) {
    const conversation: Conversation = {
      ...createConversation(
        company.id,
        customerPhone,
        'whatsapp',
        new Date(Date.now() - 3600000).toISOString(),
      ),
      version: 1,
      ...changes,
    };
    expect(await rpc('save_conversation', [conversation, 0])).toBe(true);
    return conversation;
  }
  const nonce = (n = 1) => `nonce-${String(n).padStart(5, '0')}`;
  const linkClaim = (n = 1, changes: Partial<WebOrderClaim> = {}) =>
    ({
      kind: 'link',
      nonce: nonce(n),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      keys: ['pn:923001112222'],
      ...changes,
    }) as WebOrderClaim;
  function web(conversation: Conversation, key = 'menu-link:1') {
    return buildWebOrder(company, products, conversation, cart, {
      now: now(),
      submissionKey: `${company.id}:${conversation.id}:${key}`,
    });
  }
  const jobsFor = (built: ReturnType<typeof web>) => [
    makeJob(company.id, 'whatsapp_send', {
      conversationId: built.conversation.id,
      messageId: built.replyId,
      text: built.reply,
      source: 'notice',
    }),
  ];
  const place = (
    built: ReturnType<typeof web>,
    claim: WebOrderClaim,
    { version = 1, jobs = jobsFor(built), companyId = company.id } = {},
  ) =>
    named<WebOrderOutcome>(
      'place_web_order',
      placeWebOrderArgs(companyId, built.conversation, version, built.order, jobs, claim),
    );
  const count = async (table: string) =>
    scalar(`select count(*)::int value from ${table}`) as Promise<number>;
  const hash = (c: string) => c.repeat(64);
  const draftInput = (id: string, code = 'a', changes: Record<string, unknown> = {}) =>
    ({
      id,
      companyId: company.id,
      codeHash: hash(code),
      phoneHash: hash('b'),
      cart,
      quotedTotal: 90000,
      ...changes,
    }) as never;
  const draft = (id: string, code = 'a', changes: Record<string, unknown> = {}) =>
    named<MenuDraftResult>(
      'create_menu_draft',
      createMenuDraftArgs(draftInput(id, code, changes), 30, 2000),
    );

  it('places a link order once, with its use, and answers a repeat with the same order', async () => {
    const conversation = await chat();
    const built = web(conversation);
    const placed = await place(built, linkClaim());
    expect(placed).toMatchObject({ ok: true, order: { id: built.order.id, source: 'menu_page' } });
    expect(await count('orders')).toBe(1);
    expect(
      await scalar('select order_id value from menu_link_uses where nonce=$1', [nonce()]),
    ).toBe(built.order.id);
    expect(await count("jobs where data->>'kind'='whatsapp_send'")).toBe(1);
    const stored = (await scalar('select data value from conversations where id=$1', [
      conversation.id,
    ])) as Conversation;
    expect(stored).toMatchObject({ version: 2, lastInboundAt: conversation.lastInboundAt });
    expect(stored.cart).toMatchObject({ status: 'submitted', orderId: built.order.id });
    const again = await place(built, linkClaim());
    expect(again).toMatchObject({ ok: false, reason: 'duplicate', order: { id: built.order.id } });
    expect(await count('menu_link_uses')).toBe(1);
    const other = web({ ...stored, version: 2 } as Conversation, 'menu-link:2');
    expect(await place(other, linkClaim(), { version: 2 })).toEqual({ ok: false, reason: 'used' });
    expect(
      await place(other, linkClaim(2, { expiresAt: new Date(Date.now() - 1000).toISOString() }), {
        version: 2,
      }),
    ).toEqual({ ok: false, reason: 'expired' });
    expect(await count('orders')).toBe(1);
  });

  it('refuses while the bot is off, for a blocked number, a staff chat or a changed chat', async () => {
    const conversation = await chat();
    const built = web(conversation);
    await db.query("update companies set data=jsonb_set(data,'{botEnabled}','false') where id=$1", [
      company.id,
    ]);
    expect(await place(built, linkClaim())).toEqual({ ok: false, reason: 'bot_off' });
    await db.query("update companies set data=jsonb_set(data,'{botEnabled}','true') where id=$1", [
      company.id,
    ]);
    await db.query(
      "insert into blocked_customers(company_id,key,block_id) values($1,'pn:923001112222','block-1')",
      [company.id],
    );
    expect(await place(built, linkClaim())).toEqual({ ok: false, reason: 'blocked' });
    expect(await scalar('select blocked_count value from blocked_customers')).toBe(0);
    await db.query('delete from blocked_customers');
    expect(await place(built, linkClaim(), { version: 0 })).toEqual({
      ok: false,
      reason: 'conversation_changed',
    });
    await db.query(
      `update conversations set data=jsonb_set(data,'{blocked}','{"at":"2026-10-16T10:00:00.000Z","blockId":"b"}') where id=$1`,
      [conversation.id],
    );
    expect(await place(built, linkClaim())).toEqual({ ok: false, reason: 'blocked' });
    await db.query(
      'update conversations set data=(data-\'blocked\')||\'{"mode":"human"}\' where id=$1',
      [conversation.id],
    );
    expect(await place(built, linkClaim())).toEqual({ ok: false, reason: 'staff' });
    expect(await count('orders')).toBe(0);
    expect(await count('menu_link_uses')).toBe(0);
    expect(await count('jobs')).toBe(0);
  });

  it('raises on anything but a live pending menu-page order in its own chat', async () => {
    const conversation = await chat();
    const built = web(conversation);
    const tamper = (order: object, conv: object = {}) =>
      place(
        {
          ...built,
          order: { ...built.order, ...order },
          conversation: { ...built.conversation, ...conv },
        } as never,
        linkClaim(),
      );
    await expect(tamper({ sandbox: true })).rejects.toThrow('Invalid web order');
    await expect(tamper({ source: undefined })).rejects.toThrow('Invalid web order');
    await expect(tamper({}, { lastInboundAt: now() })).rejects.toThrow(
      'must not change lastInboundAt',
    );
    await expect(
      place(built, linkClaim(), { jobs: [makeJob(other.id, 'staff_alert', {})] }),
    ).rejects.toThrow('Cross-company job');
    await expect(place(built, linkClaim(), { companyId: other.id })).rejects.toThrow(
      'Cross-company web order',
    );
    await expect(place(built, linkClaim(1, { nonce: 'bad' }))).rejects.toThrow(
      'Invalid menu link claim',
    );
    expect(await count('orders')).toBe(0);
  });

  it('lets the price check refuse a changed menu, leaving the link unused', async () => {
    const conversation = await chat();
    const built = web(conversation);
    await db.query("update products set data=jsonb_set(data,'{price}','46000') where id=$1", [
      products[0]!.id,
    ]);
    await expect(place(built, linkClaim())).rejects.toThrow('Catalog price changed');
    expect(await count('menu_link_uses')).toBe(0);
    expect(await count('orders')).toBe(0);
  });

  it('uses an order code once and forgets its name, address and hashes', async () => {
    expect(await draft('draft-1', 'a', { ipKey: 'A'.repeat(22) })).toMatchObject({
      ok: true,
      expiresAt: expect.any(String),
    });
    expect(await draft('draft-2')).toEqual({ ok: false, reason: 'collision' });
    const conversation = await chat();
    const built = buildWebOrder(company, products, conversation, cart, {
      now: now(),
      submissionKey: `${company.id}:${conversation.id}:menu-draft:draft-1`,
      customerMessage: { id: 'wamid-1', text: 'Code: OM-ABCD-EFGH' },
    });
    const claim: WebOrderClaim = { kind: 'draft', draftId: 'draft-1', keys: ['pn:923001112222'] };
    expect(await place(built, claim)).toMatchObject({ ok: true });
    const row = (
      await db.query<{
        used_at: string;
        cart: unknown;
        phone_hash: unknown;
        ip_key: unknown;
        order_id: string;
      }>("select used_at,cart,phone_hash,ip_key,order_id from menu_drafts where id='draft-1'")
    ).rows[0]!;
    expect(row).toMatchObject({
      cart: null,
      phone_hash: null,
      ip_key: null,
      order_id: built.order.id,
    });
    expect(row.used_at).not.toBeNull();
    const second = buildWebOrder(
      company,
      products,
      { ...built.conversation, version: 2 } as Conversation,
      cart,
      {
        now: now(),
        submissionKey: `${company.id}:${conversation.id}:menu-draft:draft-1b`,
      },
    );
    expect(await place(second, claim, { version: 2 })).toEqual({ ok: false, reason: 'used' });
    // A brand-new chat can start with the code message.
    expect(await draft('draft-3', 'c')).toMatchObject({ ok: true });
    const fresh = createConversation(company.id, '+923009998888', 'whatsapp', now());
    const first = buildWebOrder(company, products, fresh, cart, {
      now: now(),
      submissionKey: `${company.id}:${fresh.id}:menu-draft:draft-3`,
      customerMessage: { id: 'wamid-2', text: 'Code: OM-CCCC-CCCC' },
    });
    expect(
      await place(first, { kind: 'draft', draftId: 'draft-3', keys: [] }, { version: 0 }),
    ).toMatchObject({ ok: true });
    expect(await count('orders')).toBe(2);
  });

  it('refuses an expired code and caps open drafts', async () => {
    expect(await draft('old', 'd')).toMatchObject({ ok: true });
    await db.query(
      "update menu_drafts set created_at=now()-interval '90 minutes',expires_at=now()-interval '31 minutes' where id='old'",
    );
    const conversation = await chat();
    const built = web(conversation, 'menu-draft:old');
    expect(await place(built, { kind: 'draft', draftId: 'old', keys: [] })).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(await place(built, { kind: 'draft', draftId: 'missing', keys: [] })).toEqual({
      ok: false,
      reason: 'expired',
    });
    const capped = (id: string, code: string) =>
      named<MenuDraftResult>(
        'create_menu_draft',
        createMenuDraftArgs(
          {
            id,
            companyId: company.id,
            codeHash: hash(code),
            phoneHash: hash('b'),
            cart,
            quotedTotal: 1,
          },
          30,
          1,
        ),
      );
    expect(await capped('cap-1', 'e')).toMatchObject({ ok: true });
    expect(await capped('cap-2', 'f')).toEqual({ ok: false, reason: 'busy' });
    await expect(draft('bad', 'g', { phoneHash: 'not-a-hash' })).rejects.toThrow(
      'Invalid menu draft',
    );
    await expect(draft('bad', 'g', { ipKey: '203.0.113.9' })).rejects.toThrow('Invalid menu draft');
  });

  it('caps open drafts per network address without holding up other addresses', async () => {
    const hex = (n: number) => n.toString(16).padStart(64, '0');
    const ipA = 'A'.repeat(22);
    const ipB = 'b_-'.repeat(7) + 'B';
    const from = (n: number, ipKey?: string) =>
      draft(`d-${n}`, 'a', { codeHash: hex(n), phoneHash: hex(1000 + n), ipKey });
    for (let n = 0; n < 15; n++) expect(await from(n, ipA)).toMatchObject({ ok: true });
    expect(await from(15, ipA)).toEqual({ ok: false, reason: 'busy_source' });
    expect(await from(16, ipB)).toMatchObject({ ok: true });
    expect(await from(17)).toMatchObject({ ok: true });
    expect(await scalar("select ip_key value from menu_drafts where id='d-16'")).toBe(ipB);
    expect(await scalar("select ip_key value from menu_drafts where id='d-17'")).toBeNull();
    // Used and expired drafts no longer count.
    await db.query("update menu_drafts set used_at=now() where id='d-0'");
    await db.query(
      "update menu_drafts set created_at=now()-interval '40 minutes',expires_at=now()-interval '10 minutes' where id='d-1'",
    );
    expect(await from(18, ipA)).toMatchObject({ ok: true });
    expect(await from(19, ipA)).toMatchObject({ ok: true });
    expect(await from(20, ipA)).toEqual({ ok: false, reason: 'busy_source' });
    expect(await count('menu_drafts')).toBe(19);
  });

  it('keeps one open draft per number: a new one ends and wipes the older one', async () => {
    expect(await draft('first', '1', { ipKey: 'A'.repeat(22) })).toMatchObject({ ok: true });
    await db.query(
      "update menu_drafts set created_at=created_at-interval '1 minute',expires_at=expires_at-interval '1 minute' where id='first'",
    );
    expect(await draft('other', '2', { phoneHash: hash('c') })).toMatchObject({ ok: true });
    expect(await draft('second', '3')).toMatchObject({ ok: true });
    // A refused draft (here a code collision) leaves the number's open draft alone.
    expect(await draft('dup', '3')).toEqual({ ok: false, reason: 'collision' });
    const rows = (
      await db.query<{ id: string; open: boolean; wiped: boolean }>(
        `select id, expires_at > now() as open,
          cart is null and phone_hash is null and ip_key is null as wiped
         from menu_drafts order by id`,
      )
    ).rows;
    expect(rows).toEqual([
      { id: 'first', open: false, wiped: true },
      { id: 'other', open: true, wiped: false },
      { id: 'second', open: true, wiped: false },
    ]);
    const conversation = await chat();
    const built = web(conversation, 'menu-draft:first');
    expect(await place(built, { kind: 'draft', draftId: 'first', keys: [] })).toEqual({
      ok: false,
      reason: 'expired',
    });
    // Two drafts for one number in the same transaction: the first still ends after it began.
    await db.query(
      'select public.create_menu_draft($1, 30, 2000) a, public.create_menu_draft($2, 30, 2000) b',
      [
        createMenuDraftArgs(draftInput('same-1', '4', { phoneHash: hash('d') }), 30, 2000).p_draft,
        createMenuDraftArgs(draftInput('same-2', '5', { phoneHash: hash('d') }), 30, 2000).p_draft,
      ],
    );
    expect(
      (
        await db.query<{ id: string; ok: boolean; wiped: boolean }>(
          `select id, expires_at > created_at as ok, cart is null as wiped
           from menu_drafts where id like 'same-%' order by id`,
        )
      ).rows,
    ).toEqual([
      { id: 'same-1', ok: true, wiped: true },
      { id: 'same-2', ok: true, wiped: false },
    ]);
  });

  it('purges expired drafts and old link uses on schedule', async () => {
    const ipKey = 'A'.repeat(22);
    expect(await draft('soon', '1', { phoneHash: hash('1'), ipKey })).toMatchObject({ ok: true });
    expect(await draft('gone', '2', { phoneHash: hash('2') })).toMatchObject({ ok: true });
    expect(await draft('open', '3', { phoneHash: hash('3'), ipKey })).toMatchObject({ ok: true });
    await db.query(
      "update menu_drafts set created_at=now()-interval '40 minutes',expires_at=now()-interval '5 minutes' where id='soon'",
    );
    await db.query(
      "update menu_drafts set created_at=now()-interval '3 hours',expires_at=now()-interval '2 hours' where id='gone'",
    );
    const conversation = await chat();
    await db.query(
      "insert into menu_link_uses(company_id,nonce,conversation_id,order_id,expires_at) values($1,$2,$3,'o',now()-interval '2 hours')",
      [company.id, nonce(9), conversation.id],
    );
    // Two expired drafts wiped, one of them old enough to remove, and one old link use.
    expect(await rpc('purge_menu_ordering', [])).toBe(4);
    const rows = (
      await db.query<{ id: string; cart: unknown; phone_hash: unknown; ip_key: unknown }>(
        'select id,cart,phone_hash,ip_key from menu_drafts order by id',
      )
    ).rows;
    expect(
      rows.map((r) => [r.id, r.cart === null, r.phone_hash === null, r.ip_key === null]),
    ).toEqual([
      ['open', false, false, false],
      ['soon', true, true, true],
    ]);
    expect(await count('menu_link_uses')).toBe(0);
    expect(await rpc('purge_menu_ordering', [])).toBe(0);
  });

  it('keeps erasing customers and retention working with used links', async () => {
    const conversation = await chat();
    await db.query(
      "insert into menu_link_uses(company_id,nonce,conversation_id,order_id,expires_at) values($1,$2,$3,'o',now())",
      [company.id, nonce(1), conversation.id],
    );
    await db.query("update companies set data=jsonb_set(data,'{botEnabled}','false') where id=$1", [
      company.id,
    ]);
    expect(await rpc('erase_customer', [company.id, phone])).toBe(1);
    expect(await count('menu_link_uses')).toBe(0);
    const old = await chat('+923004445555');
    await db.query(
      "insert into menu_link_uses(company_id,nonce,conversation_id,order_id,expires_at) values($1,$2,$3,'o',now())",
      [company.id, nonce(2), old.id],
    );
    await db.query(
      "update conversations set updated_at=now()-interval '120 days',data=data||jsonb_build_object('updatedAt',now()-interval '120 days','lastInboundAt',now()-interval '120 days') where id=$1",
      [old.id],
    );
    await rpc('configure_retention', [company.id, 30, ownerId]);
    await db.query(
      "update retention_policies set eligible_after=now()-interval '1 minute' where company_id=$1",
      [company.id],
    );
    expect(await rpc('run_retention', [company.id])).toBe(1);
    expect(await count('menu_link_uses')).toBe(0);
  });

  it('is server-only and can be applied again', async () => {
    expect(await draft('keep', '9', { ipKey: 'A'.repeat(22) })).toMatchObject({ ok: true });
    await db.exec(readFileSync('supabase/migrations/202610190002_menu_ordering.sql', 'utf8'));
    expect(await count('menu_drafts')).toBe(1);
    expect(await scalar("select ip_key value from menu_drafts where id='keep'")).toBe(
      'A'.repeat(22),
    );
    const conversation = await chat();
    const built = web(conversation);
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      try {
        await expect(draft('x', '8')).rejects.toThrow(DENIED);
        await expect(draft('y', '7', { ipKey: 'B'.repeat(22) })).rejects.toThrow(DENIED);
        await expect(place(built, linkClaim())).rejects.toThrow(DENIED);
        await expect(rpc('purge_menu_ordering', [])).rejects.toThrow(DENIED);
        for (const table of ['menu_drafts', 'menu_link_uses'])
          await expect(db.query(`select * from ${table}`)).rejects.toThrow(DENIED);
      } finally {
        await db.exec('reset role');
      }
    }
  });
});
