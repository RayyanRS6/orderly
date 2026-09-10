import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import { createConversation, processTurn } from '../src/domain/engine';
import { makeJob } from '../server/jobs';
import type { BotAction, Conversation, Order } from '../src/shared/types';

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
function pendingOrder() {
  let conversation = createConversation(company.id, '+923000000099', 'demo', now());
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
    `create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; grant usage on schema auth to authenticated,service_role; grant execute on function auth.uid() to authenticated,service_role;`,
  );
  for (const migration of ['202609090001_initial.sql', '202609090002_order_transitions.sql'])
    await db.exec(readFileSync(`supabase/migrations/${migration}`, 'utf8'));
  await db.query('insert into auth.users(id) values($1),($2)', [ownerId, outsiderId]);
}, 30000);
beforeEach(async () => {
  await db.exec(
    'reset role; truncate public.companies cascade; delete from public.platform_admins;',
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
