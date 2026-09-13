import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const db = new PGlite();
const workerUrl = 'https://abcdefghijklmnopqrst.supabase.co/functions/v1/orderly/api/jobs/process';
const workerToken = 'test-worker-token-for-scheduler-1234567890';
const migration = readFileSync('supabase/migrations/202609110001_job_dispatch.sql', 'utf8');
// PGlite runs the actual application functions, triggers, grants and cron SQL.
// Only extension installation is omitted; their external I/O/storage is stubbed.
const executableMigration = migration.replace(/^create extension [^;]+;\r?$/gm, '');
const now = () => new Date().toISOString();
const offset = (milliseconds: number) => new Date(Date.now() + milliseconds).toISOString();
async function scalar(sql: string, args: unknown[] = []) {
  return (await db.query<{ value: unknown }>(sql, args)).rows[0]?.value;
}
async function configure() {
  return scalar('select public.configure_orderly_scheduler($1,$2) as value', [
    workerUrl,
    workerToken,
  ]);
}
async function insertJob(
  id: string,
  options: {
    status?: string;
    phone?: string;
    nextRunAt?: string;
    leaseUntil?: string;
    kind?: string;
    companyId?: string;
    attempts?: number;
    orderId?: string;
  } = {},
) {
  const job = {
    id,
    companyId: options.companyId ?? 'company-a',
    kind: options.kind ?? 'incoming',
    payload: {
      phone: options.phone ?? id,
      ...(options.orderId ? { orderId: options.orderId } : {}),
    },
    status: options.status ?? 'pending',
    attempts: options.attempts ?? 0,
    nextRunAt: options.nextRunAt ?? offset(-1000),
    leaseUntil: options.leaseUntil,
    createdAt: now(),
  };
  await db.query('select public.insert_job($1)', [job]);
  return job;
}
async function insertConversation(
  id: string,
  companyId = 'company-a',
  channel = 'whatsapp',
  phone = id,
) {
  const conversation = {
    id,
    companyId,
    channel,
    customerPhone: phone,
    version: 3,
    mode: 'bot',
    updatedAt: offset(-60000),
    cart: { items: [] },
    messages: [{ id: 'preserve-message' }],
  };
  await db.query('select public.save_conversation($1)', [conversation]);
  return conversation;
}
async function insertOrder(
  id: string,
  syncStatus = 'pending',
  updatedAt = offset(-60000),
  companyId = 'company-a',
) {
  const conversation = await insertConversation(`conversation-${id}`, companyId);
  const productId = `product-${id}`;
  await db.query(
    `update public.companies set data=data||'{"botEnabled":true}'::jsonb where id=$1`,
    [companyId],
  );
  await db.query('insert into public.products(id,company_id,data) values($1,$2,$3)', [
    productId,
    companyId,
    { id: productId, companyId, available: true, price: 100 },
  ]);
  const order = {
    id,
    companyId,
    conversationId: conversation.id,
    submissionKey: id,
    createdAt: updatedAt,
    updatedAt,
    status: 'pending',
    syncStatus,
    customerName: 'Test customer',
    fulfillment: 'pickup',
    items: [{ productId, quantity: 1, unitPrice: 100, total: 100, modifiers: [] }],
    subtotal: 100,
    deliveryFee: 0,
    total: 100,
  };
  await db.query(
    `insert into public.orders(id,company_id,conversation_id,submission_key,created_at,updated_at,data)
    values($1,$2,$3,$1,$4,$4,$5)`,
    [id, companyId, conversation.id, updatedAt, order],
  );
  return order;
}
async function dispatchedIds() {
  return (
    await db.query<{ id: string }>(
      `select body->>'jobId' as id from net.http_request_queue order by id`,
    )
  ).rows.map((row) => row.id);
}

beforeAll(async () => {
  expect(migration.match(/^create extension [^;]+;/gm)).toHaveLength(3);
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
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
    create table net._http_response(id bigint);
    create table net.test_failure(enabled boolean);
    create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds integer default 2000)
    returns bigint language plpgsql as $$
    declare request_id bigint;
    begin
      if exists(select 1 from net.test_failure where enabled) then raise exception 'Test HTTP transport is unavailable'; end if;
      insert into net.http_request_queue(url,body,headers,timeout_milliseconds)
        values(url,body,headers,timeout_milliseconds) returning id into request_id;
      return request_id;
    end;
    $$;
    create schema cron;
    create table cron.job(jobid bigserial primary key, jobname text unique, schedule text, command text, active boolean default true);
    create table cron.job_run_details(runid bigserial primary key, jobid bigint, end_time timestamptz);
    create function cron.schedule(job_name text, job_schedule text, job_command text) returns bigint language sql as $$
      insert into cron.job(jobname,schedule,command) values(job_name,job_schedule,job_command)
        on conflict(jobname) do update set schedule=excluded.schedule,command=excluded.command returning jobid;
    $$;
  `);
  for (const filename of ['202609090001_initial.sql', '202609090002_order_transitions.sql'])
    await db.exec(readFileSync(`supabase/migrations/${filename}`, 'utf8'));
  await db.exec(executableMigration);
}, 30000);

beforeEach(async () => {
  await db.exec(`reset role; truncate public.companies cascade; truncate vault.secrets,net.http_request_queue,net.test_failure,cron.job_run_details;
    delete from cron.job where jobname not in ('orderly-recover-jobs','orderly-prune-cron-history');`);
  for (const id of ['company-a', 'company-b'])
    await db.query('insert into public.companies(id,slug,data) values($1,$1,$2)', [
      id,
      { id, slug: id },
    ]);
});
afterAll(async () => {
  await db.close();
});

describe('Supabase durable dispatch and scheduler', () => {
  it('schedules database checks without any HTTP requests before setup or while idle', async () => {
    await insertJob('pending');
    expect(await scalar('select public.orderly_scheduler_ready() as value')).toBe(false);
    const command = await scalar(
      `select command as value from cron.job where jobname='orderly-recover-jobs'`,
    );
    await db.exec(String(command));
    expect(await scalar('select public.dispatch_orderly_job($1) as value', ['pending'])).toBeNull();
    expect(await dispatchedIds()).toEqual([]);
    expect(await scalar('select public.orderly_scheduler_status() as value')).toMatchObject({
      configured: false,
      workerUrlConfigured: false,
      workerTokenConfigured: false,
      recoveryScheduled: true,
    });
    await db.exec('truncate public.jobs cascade');
    expect(await configure()).toBe(true);
    await db.exec(String(command));
    expect(await dispatchedIds()).toEqual([]);
  });

  it('dispatches a due job with only its ID and worker authorization, leaving the claim untouched', async () => {
    await configure();
    const job = await insertJob('ready');
    await db.exec('set role service_role');
    expect(
      await scalar('select public.dispatch_orderly_job($1) as value', [job.id]),
    ).not.toBeNull();
    await db.exec('reset role');
    expect((await db.query('select url,body,headers from net.http_request_queue')).rows).toEqual([
      {
        url: workerUrl,
        body: { jobId: job.id },
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${workerToken}` },
      },
    ]);
    expect(await scalar('select data as value from public.jobs where id=$1', [job.id])).toEqual(
      job,
    );
    expect(await scalar('select public.dispatch_orderly_job($1) as value', [job.id])).toBeNull();
    expect(await scalar('select public.recover_orderly_jobs() as value')).toBe(0);
    await db.query(
      `update public.jobs set last_dispatched_at=now()-interval '46 seconds' where id=$1`,
      [job.id],
    );
    expect(await scalar('select public.recover_orderly_jobs() as value')).toBe(1);
  });

  it('recovers expired leases but excludes future jobs, active workers, completed work and failed barriers', async () => {
    await configure();
    await insertJob('failed-head', { status: 'failed', phone: 'blocked' });
    await insertJob('behind-failure', { phone: 'blocked' });
    await insertJob('future', { nextRunAt: offset(3600000) });
    await insertJob('active', { status: 'processing', leaseUntil: offset(3600000) });
    await insertJob('done', { status: 'done' });
    await insertJob('expired', { status: 'processing', leaseUntil: offset(-60000) });
    await insertJob('missing-lease', { status: 'processing' });
    await insertJob('ready');
    expect(await scalar('select public.recover_orderly_jobs() as value')).toBe(3);
    expect((await dispatchedIds()).sort()).toEqual(['expired', 'missing-lease', 'ready']);
    expect(
      await scalar('select public.dispatch_orderly_job($1) as value', ['behind-failure']),
    ).toBeNull();
  });

  it('finishes exhausted crashed jobs without another invocation, preserving active leases and the fifth attempt', async () => {
    await configure();
    await insertJob('crashed-five', {
      status: 'processing',
      attempts: 5,
      leaseUntil: offset(-60000),
    });
    await insertJob('pending-five', { status: 'pending', attempts: 5 });
    await insertJob('active-five', {
      status: 'processing',
      attempts: 5,
      leaseUntil: offset(60000),
    });
    await insertJob('crashed-four', {
      status: 'processing',
      attempts: 4,
      leaseUntil: offset(-60000),
    });
    for (const id of ['crashed-five', 'pending-five'])
      expect(await scalar('select public.dispatch_orderly_job($1) as value', [id])).toBeNull();
    expect(await scalar('select public.recover_orderly_jobs() as value')).toBe(1);
    expect(await dispatchedIds()).toEqual(['crashed-four']);
    const failed = await scalar('select data as value from public.jobs where id=$1', [
      'crashed-five',
    ]);
    expect(failed).toMatchObject({
      status: 'failed',
      attempts: 5,
      error: expect.stringContaining('retry limit'),
    });
    expect(failed).not.toHaveProperty('leaseUntil');
    expect(
      await scalar('select lease_until as value from public.jobs where id=$1', ['crashed-five']),
    ).toBeNull();
    expect(
      await scalar('select status as value from public.jobs where id=$1', ['pending-five']),
    ).toBe('failed');
    expect(
      await scalar('select status as value from public.jobs where id=$1', ['active-five']),
    ).toBe('processing');
    expect(await scalar('select public.recover_orderly_jobs() as value')).toBe(0);
    expect(await scalar('select count(*)::int as value from public.traces')).toBe(2);
  });

  it('marks only the failed incoming conversation for staff and preserves FIFO until manual retry', async () => {
    await configure();
    const affected = await insertConversation('affected', 'company-a', 'whatsapp', 'same-phone');
    const otherTenant = await insertConversation(
      'other-tenant',
      'company-b',
      'whatsapp',
      'same-phone',
    );
    const demo = await insertConversation('demo', 'company-a', 'demo', 'same-phone');
    await insertJob('failed-head', {
      phone: 'same-phone',
      status: 'processing',
      attempts: 5,
      leaseUntil: offset(-60000),
    });
    await insertJob('successor', { phone: 'same-phone' });
    expect(await scalar('select public.recover_orderly_jobs() as value')).toBe(0);
    expect(
      await scalar('select data as value from public.conversations where id=$1', ['affected']),
    ).toMatchObject({
      ...affected,
      mode: 'human',
      version: 4,
      updatedAt: expect.any(String),
    });
    expect(
      await scalar('select version as value from public.conversations where id=$1', ['affected']),
    ).toBe(4);
    expect(
      await scalar('select data as value from public.conversations where id=$1', ['other-tenant']),
    ).toEqual(otherTenant);
    expect(
      await scalar('select data as value from public.conversations where id=$1', ['demo']),
    ).toEqual(demo);
    expect(await scalar('select data as value from public.traces')).toMatchObject({
      companyId: 'company-a',
      conversationId: 'affected',
      action: 'job.failed',
    });
    expect(await scalar('select public.recover_orderly_jobs() as value')).toBe(0);
    expect(
      await scalar('select version as value from public.conversations where id=$1', ['affected']),
    ).toBe(4);
    expect(await scalar('select count(*)::int as value from public.traces')).toBe(1);
    expect(await scalar('select public.retry_failed_jobs($1) as value', ['company-b'])).toBe(0);
    expect(await scalar('select public.retry_failed_jobs($1) as value', ['company-a'])).toBe(1);
    expect(
      await scalar('select attempts as value from public.jobs where id=$1', ['failed-head']),
    ).toBe(0);
    expect(await scalar('select public.recover_orderly_jobs() as value')).toBe(1);
    expect(await dispatchedIds()).toEqual(['failed-head']);
    await db.query(
      `update public.jobs set status='done',data=data||'{"status":"done"}'::jsonb where id=$1`,
      ['failed-head'],
    );
    expect(await dispatchedIds()).toEqual(['failed-head', 'successor']);
    expect(
      await scalar("select data->>'mode' as value from public.conversations where id=$1", [
        'affected',
      ]),
    ).toBe('human');
  });

  it('bounds crash cleanup at twenty rows and records each failure only once without configured HTTP transport', async () => {
    for (let index = 0; index < 25; index++)
      await insertJob(`crashed-${index}`, { status: 'processing', attempts: 5 });
    expect(await scalar('select public.fail_exhausted_orderly_jobs(10000) as value')).toBe(20);
    expect(
      await scalar("select count(*)::int as value from public.jobs where status='failed'"),
    ).toBe(20);
    expect(await scalar('select public.recover_orderly_jobs() as value')).toBe(0);
    expect(
      await scalar("select count(*)::int as value from public.jobs where status='failed'"),
    ).toBe(25);
    expect(await scalar('select public.fail_exhausted_orderly_jobs() as value')).toBe(0);
    expect(await scalar('select count(*)::int as value from public.traces')).toBe(25);
    expect(await dispatchedIds()).toEqual([]);
  });

  it('marks the latest failed sheet write without overwriting newer orders, successful writes or other tenants', async () => {
    const eligible = await insertOrder('eligible');
    const changed = await insertOrder('changed', 'pending', offset(60000));
    const synced = await insertOrder('synced', 'synced');
    const newerJob = await insertOrder('newer-job');
    const otherTenant = await insertOrder('other-tenant', 'pending', offset(-60000), 'company-b');
    for (const order of [eligible, changed, synced, newerJob])
      await insertJob(`sync-${order.id}`, {
        kind: 'sheet_sync',
        orderId: order.id,
        status: 'processing',
        attempts: 5,
        leaseUntil: offset(-60000),
      });
    await insertJob('later-sync', {
      kind: 'sheet_sync',
      orderId: newerJob.id,
      nextRunAt: offset(60000),
    });
    expect(await scalar('select public.recover_orderly_jobs() as value')).toBe(0);
    expect(
      await scalar('select data as value from public.orders where id=$1', [eligible.id]),
    ).toEqual({ ...eligible, syncStatus: 'failed' });
    for (const order of [changed, synced, newerJob, otherTenant])
      expect(
        await scalar('select data as value from public.orders where id=$1', [order.id]),
      ).toEqual(order);
    expect(await scalar('select count(*)::int as value from public.traces')).toBe(4);
    expect(await dispatchedIds()).toEqual([]);
  });

  it('immediately releases only the next incoming message for the same company and phone', async () => {
    await configure();
    await insertJob('head', { phone: 'customer' });
    await insertJob('next', { phone: 'customer' });
    await insertJob('later', { phone: 'customer' });
    await insertJob('other-tenant', { phone: 'customer', companyId: 'company-b' });
    await insertJob('other-customer', { phone: 'different' });
    expect(await scalar('select public.dispatch_orderly_job($1) as value', ['next'])).toBeNull();
    await db.query(
      `update public.jobs set status='done',data=data||'{"status":"done"}'::jsonb where id=$1`,
      ['head'],
    );
    expect(await dispatchedIds()).toEqual(['next']);
    expect(
      await scalar('select public.claim_job($1,$2,$3) as value', ['later', now(), offset(90000)]),
    ).toBeNull();
    expect(
      await scalar('select public.claim_job($1,$2,$3) as value', ['next', now(), offset(90000)]),
    ).toMatchObject({ id: 'next', status: 'processing' });
  });

  it('preserves completion when transport fails and retries the saved successor later', async () => {
    await configure();
    await insertJob('head', { phone: 'customer' });
    await insertJob('next', { phone: 'customer' });
    await db.exec('insert into net.test_failure values(true)');
    await db.query(
      `update public.jobs set status='done',data=data||'{"status":"done"}'::jsonb where id=$1`,
      ['head'],
    );
    expect(await scalar('select status as value from public.jobs where id=$1', ['head'])).toBe(
      'done',
    );
    expect(await scalar('select public.recover_orderly_jobs() as value')).toBe(0);
    expect(
      await scalar('select last_dispatched_at as value from public.jobs where id=$1', ['next']),
    ).toBeNull();
    await db.exec('truncate net.test_failure');
    expect(await scalar('select public.recover_orderly_jobs() as value')).toBe(1);
    expect(await dispatchedIds()).toEqual(['next']);
  });

  it('caps a recovery run at 20 and continues past already notified jobs without spending idle invocations', async () => {
    await configure();
    for (let index = 0; index < 25; index++) await insertJob(`job-${index}`);
    expect(await scalar('select public.recover_orderly_jobs(10000) as value')).toBe(20);
    expect(await scalar('select public.recover_orderly_jobs() as value')).toBe(5);
    expect(await scalar('select public.recover_orderly_jobs() as value')).toBe(0);
    expect(new Set(await dispatchedIds()).size).toBe(25);
  });

  it('rejects unsafe setup, rotates the two named secrets without duplicates and hides them from diagnostics', async () => {
    for (const invalidUrl of [
      'http://127.0.0.1:4000/api/jobs/process',
      'https://attacker.example/process',
      `${workerUrl}?redirect=https://example.com`,
    ])
      await expect(
        scalar('select public.configure_orderly_scheduler($1,$2) as value', [
          invalidUrl,
          workerToken,
        ]),
      ).rejects.toThrow('Worker URL');
    await expect(
      scalar('select public.configure_orderly_scheduler($1,$2) as value', [workerUrl, 'short']),
    ).rejects.toThrow('Worker token');
    await configure();
    await scalar('select public.configure_orderly_scheduler($1,$2) as value', [
      workerUrl,
      `${workerToken}-rotated`,
    ]);
    expect(await scalar('select count(*)::int as value from vault.secrets')).toBe(2);
    expect(await scalar('select public.orderly_scheduler_status() as value')).toEqual({
      configured: true,
      workerUrlConfigured: true,
      workerTokenConfigured: true,
      recoveryScheduled: true,
      batchSize: 20,
      dispatchThrottleSeconds: 45,
    });
    await insertJob('ready');
    await scalar('select public.dispatch_orderly_job($1) as value', ['ready']);
    expect(
      await scalar(`select headers->>'Authorization' as value from net.http_request_queue`),
    ).toBe(`Bearer ${workerToken}-rotated`);
  });

  it('denies scheduler and Vault access to browser roles while preserving service-role RPC access', async () => {
    await configure();
    const signatures = [
      'public.orderly_scheduler_ready()',
      'public.configure_orderly_scheduler(text,text)',
      'public.dispatch_orderly_job(text)',
      'public.fail_exhausted_orderly_jobs(integer)',
      'public.recover_orderly_jobs(integer)',
      'public.dispatch_next_orderly_incoming()',
      'public.prune_orderly_cron_history()',
      'public.orderly_scheduler_status()',
    ];
    for (const role of ['anon', 'authenticated']) {
      for (const signature of signatures)
        expect(
          await scalar(`select has_function_privilege($1,$2,'EXECUTE') as value`, [
            role,
            signature,
          ]),
        ).toBe(false);
      await db.exec(`set role ${role}`);
      await expect(
        scalar('select public.dispatch_orderly_job($1) as value', ['anything']),
      ).rejects.toThrow('permission denied');
      await expect(scalar('select secret as value from vault.secrets limit 1')).rejects.toThrow(
        'permission denied',
      );
      await db.exec('reset role');
    }
    await db.exec('set role service_role');
    expect(await scalar('select public.orderly_scheduler_ready() as value')).toBe(true);
  });

  it('keeps recent/running and unrelated cron history and can rerun the migration without duplicating jobs', async () => {
    await db.exec(executableMigration);
    expect(await scalar('select count(*)::int as value from cron.job')).toBe(2);
    await db.exec(`
      select cron.schedule('unrelated-job','* * * * *','select 1;');
      insert into cron.job_run_details(jobid,end_time) select jobid,now()-interval '4 days' from cron.job;
      insert into cron.job_run_details(jobid,end_time) select jobid,now()-interval '1 day' from cron.job where jobname='orderly-recover-jobs';
      insert into cron.job_run_details(jobid,end_time) select jobid,null from cron.job where jobname='orderly-recover-jobs';
    `);
    expect(await scalar('select public.prune_orderly_cron_history() as value')).toBe(2);
    expect(await scalar('select count(*)::int as value from cron.job_run_details')).toBe(3);
    expect(
      await scalar(
        `select count(*)::int as value from cron.job_run_details join cron.job using(jobid) where jobname='unrelated-job'`,
      ),
    ).toBe(1);
  });
});
