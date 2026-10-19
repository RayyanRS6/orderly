// F21 (sql-1, docs-privacy-1): a job's duplicate key keeps only its SHA-256, so erasure,
// retention and the purge leave nothing of the customer's number in it, and a Meta delivery
// status leaves no message ID in the activity log. On the whole migration chain, in the local
// store and through the webhook.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createApp } from '../server/app';
import { makeJob } from '../server/jobs';
import { MemoryRepository } from '../server/repository';
import { encryptSecret } from '../server/security';
import { createConversation } from '../src/domain/engine';
import { seedCompanies } from '../src/shared/seed';
import type { Job } from '../src/shared/types';
import { migratedDb } from './helpers/migrated-db';

const company = seedCompanies[0]!;
const now = () => new Date().toISOString();
const sha256 = (key: string) => createHash('sha256').update(key, 'utf8').digest('hex');
// Part 1 as pasted again in the SQL editor (it is safe to rerun).
const PART_1 = readFileSync('supabase/migrations/202610200001_prelaunch_fixes.sql', 'utf8').replace(
  /^create extension [^;]+;\r?$/gm,
  '',
);
const incoming = (phone: string, extra: Record<string, unknown> = {}) =>
  makeJob(company.id, 'incoming', {
    phone,
    messageId: `wamid.${randomUUID()}`,
    text: 'hi',
    ...extra,
  });
const connection = '756bc31b-63af-4ce9-8324-1fd87803ae71';
const peer = '923001234567@s.whatsapp.net';

describe('in the database', () => {
  let t: Awaited<ReturnType<typeof migratedDb>>;
  const scalar = <T = unknown>(text: string, args: unknown[] = []) => t.scalar<T>(text, args);
  const rpc = <T = unknown>(name: string, args: unknown[] = []) => t.rpc<T>(name, args);
  const keyOf = (id: string) =>
    scalar<string | null>('select dedupe_key as value from jobs where id=$1', [id]);
  const insert = (job: Job, key: string | null) => rpc<boolean>('insert_job', [job, key]);
  beforeAll(async () => {
    t = await migratedDb();
  }, 30000);
  beforeEach(() => t.reset());
  afterAll(() => t.db.close());

  it('keeps only the hash of a message’s key, and still refuses the same message twice', async () => {
    const meta = incoming('923001234567');
    const metaKey = `555:${meta.payload.messageId}`;
    expect(await insert(meta, metaKey)).toBe(true);
    expect(await keyOf(meta.id)).toBe(sha256(metaKey));
    // A webhook retry: the same raw key, from any backend.
    expect(await insert({ ...meta, id: randomUUID() }, metaKey)).toBe(false);

    const echo = incoming('923001234567', { echo: true });
    const echoKey = `555:echo:${echo.payload.messageId}`;
    expect(await insert(echo, echoKey)).toBe(true);
    expect(await keyOf(echo.id)).toBe(sha256(echoKey));

    const linked = incoming('+923001234567');
    const linkedKey = `baileys:${connection}:1:MSG-1:${peer}`;
    expect(await insert(linked, linkedKey)).toBe(true);
    expect(await keyOf(linked.id)).toBe(sha256(linkedKey));
    expect(await insert({ ...linked, id: randomUUID() }, linkedKey)).toBe(false);

    // Orderly's own keys name no customer and are read back as they are.
    const alert = makeJob(company.id, 'staff_alert', { userId: randomUUID() });
    expect(await insert(alert, `staff-alert:${company.id}:u:1`)).toBe(true);
    expect(await keyOf(alert.id)).toBe(`staff-alert:${company.id}:u:1`);
    const hashed = incoming('923001234567');
    expect(await insert(hashed, sha256('already'))).toBe(true);
    expect(await keyOf(hashed.id)).toBe(sha256('already'));
    const unkeyed = incoming('923001234567');
    expect(await insert(unkeyed, null)).toBe(true);
    expect(await keyOf(unkeyed.id)).toBeNull();

    // A key written later is hashed too.
    await t.db.query('update jobs set dedupe_key=$2 where id=$1', [unkeyed.id, 'raw:923001234567']);
    expect(await keyOf(unkeyed.id)).toBe(sha256('raw:923001234567'));
    expect(
      await scalar<number>("select count(*)::int as value from jobs where dedupe_key ~ '9230012'"),
    ).toBe(0);
  });

  it('leaves no part of an erased customer’s number in any job key', async () => {
    await t.db.query(
      "update companies set data=jsonb_set(data,'{botEnabled}','false') where id=$1",
      [company.id],
    );
    const c = {
      ...createConversation(company.id, '+923001234567', 'whatsapp', now()),
      whatsappAddress: {
        connectionId: connection,
        generation: 1,
        provider: 'baileys' as const,
        peer,
      },
      version: 1,
    };
    expect(await rpc('save_conversation', [c, 0])).toBe(true);
    const linked = incoming('+923001234567', { whatsappAddress: c.whatsappAddress });
    const meta = incoming('923001234567');
    expect(await insert(linked, `baileys:${connection}:1:MSG-2:${peer}`)).toBe(true);
    expect(await insert(meta, `555:${meta.payload.messageId}`)).toBe(true);
    expect(await rpc('erase_customer', [company.id, '+923001234567'])).toBe(1);
    const rows = (
      await t.db.query<{ key: string; payload: unknown }>(
        "select dedupe_key as key, data->'payload' as payload from jobs where data->>'kind'='incoming'",
      )
    ).rows;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.key).toMatch(/^[0-9a-f]{64}$/);
      expect(row.payload).toEqual({});
    }
  });

  it('is for the trigger only, and works for the server’s own role', async () => {
    for (const role of ['anon', 'authenticated', 'service_role'])
      expect(
        await scalar(
          "select has_function_privilege($1,'public.hash_job_dedupe_key()','EXECUTE') as value",
          [role],
        ),
        role,
      ).toBe(false);
    await t.db.exec('set role service_role');
    try {
      const job = incoming('923001234567');
      expect(await insert(job, `555:${job.payload.messageId}`)).toBe(true);
      expect(await keyOf(job.id)).toBe(sha256(`555:${job.payload.messageId}`));
    } finally {
      await t.db.exec('reset role');
    }
  });

  it('hashes the keys saved before part 1, removes Meta status traces, and changes nothing on a rerun', async () => {
    // As before part 1: no trigger, raw keys.
    await t.db.exec('drop trigger orderly_hash_dedupe_key on public.jobs');
    try {
      const meta = incoming('923001234567');
      const linked = incoming('+923001234567');
      const alert = makeJob(company.id, 'staff_alert', { userId: randomUUID() });
      await insert(meta, `555:${meta.payload.messageId}`);
      await insert(linked, `baileys:${connection}:1:MSG-3:${peer}`);
      await insert(alert, `staff-alert:${company.id}:u:2`);
      expect(await keyOf(linked.id)).toBe(`baileys:${connection}:1:MSG-3:${peer}`);
      const c = {
        ...createConversation(company.id, '+923001110000', 'whatsapp', now()),
        version: 1,
      };
      await rpc('save_conversation', [c, 0]);
      const trace = (id: string, detail: string, conversationId: string | null = null) =>
        t.db.query(
          `insert into traces(id,company_id,conversation_id,data,created_at) values($1,$2,$3,
             jsonb_strip_nulls(jsonb_build_object('id',$1::text,'companyId',$2::text,'conversationId',$3::text,
               'action','whatsapp.read','detail',$4::text,'createdAt',now())),now())`,
          [id, company.id, conversationId, detail],
        );
      await trace('status-1', 'Meta message wamid.HBgMOTIzMDAxMjM0NTY3FQIAERgS');
      await trace('status-2', 'Meta message wamid.other');
      await trace('in-chat', 'Meta message wamid.kept', c.id);
      await trace('other', 'Order ORD-1 accepted');

      await t.db.exec(PART_1);
      expect(await keyOf(meta.id)).toBe(sha256(`555:${meta.payload.messageId}`));
      expect(await keyOf(linked.id)).toBe(sha256(`baileys:${connection}:1:MSG-3:${peer}`));
      expect(await keyOf(alert.id)).toBe(`staff-alert:${company.id}:u:2`);
      // Still recognised after the backfill.
      expect(await insert({ ...meta, id: randomUUID() }, `555:${meta.payload.messageId}`)).toBe(
        false,
      );
      const traces = async () =>
        (await t.db.query<{ id: string }>('select id from traces order by id')).rows.map(
          (r) => r.id,
        );
      expect(await traces()).toEqual(['in-chat', 'other']);

      const keys = async () =>
        (await t.db.query('select id,dedupe_key from jobs order by id')).rows;
      const before = await keys();
      await t.db.exec(PART_1);
      expect(await keys()).toEqual(before);
      expect(await traces()).toEqual(['in-chat', 'other']);
    } finally {
      await t.db.exec(PART_1);
    }
  });
});

describe('in the local store', () => {
  it('keeps only the hash, and still refuses the same message twice', async () => {
    const repo = new MemoryRepository(false);
    await repo.saveCompany(company);
    const key = `baileys:${connection}:1:MSG-1:${peer}`;
    const job = incoming('+923001234567');
    expect(await repo.insertJob(job, key)).toBe(true);
    expect(await repo.insertJob({ ...job, id: randomUUID() }, key)).toBe(false);
    const meta = incoming('923001234567');
    expect(await repo.insertJob(meta, '555:wamid.HBgMOTIzMDAxMjM0NTY3')).toBe(true);
    const alert = makeJob(company.id, 'staff_alert', { userId: 'u' });
    expect(await repo.insertJob(alert, `staff-alert:${company.id}:u:1`)).toBe(true);
    const keys = Object.keys(
      (repo as unknown as { state: { dedupe: Record<string, string> } }).state.dedupe,
    );
    expect(keys.sort()).toEqual(
      [
        sha256(key),
        sha256('555:wamid.HBgMOTIzMDAxMjM0NTY3'),
        `staff-alert:${company.id}:u:1`,
      ].sort(),
    );
    expect(keys.join()).not.toContain('9230012');
  });
});

describe('a Meta delivery status', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('records every receipt, and traces only a failed delivery, without its ID', async () => {
    vi.stubEnv('APP_MODE', 'live');
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('ORDERLY_RUNTIME', '');
    vi.stubEnv('META_APP_SECRET', 'test-app-secret');
    vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('Unexpected network request'))),
    );
    const repo = new MemoryRepository();
    await repo.saveIntegration(
      company.id,
      { kind: 'whatsapp', configured: true, status: 'connected', config: { phoneNumberId: '555' } },
      encryptSecret('token'),
    );
    const receipts = vi.spyOn(repo, 'recordDelivery');
    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '555' },
                statuses: [
                  { id: 'wamid.HBgMOTIzMDAxMjM0NTY3FQIAERgSMQ', status: 'sent' },
                  { id: 'wamid.HBgMOTIzMDAxMjM0NTY3FQIAERgSMg', status: 'read' },
                  {
                    id: 'wamid.HBgMOTIzMDAxMjM0NTY3FQIAERgSMw',
                    status: 'failed',
                    errors: [{ code: 131047 }],
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const response = await createApp(repo).request('http://127.0.0.1/api/webhooks/whatsapp', {
      method: 'POST',
      body,
      headers: {
        'x-hub-signature-256': `sha256=${createHmac('sha256', 'test-app-secret').update(body).digest('hex')}`,
      },
    });
    expect(response.status).toBe(200);
    expect(receipts).toHaveBeenCalledTimes(3);
    const traces = await repo.listTraces(company.id);
    expect(
      traces.filter((t) => t.action.startsWith('whatsapp.')).map((t) => [t.action, t.detail]),
    ).toEqual([
      [
        'whatsapp.failed',
        'Meta could not deliver a message (error 131047). Check the business number and account health.',
      ],
    ]);
    expect(JSON.stringify(traces)).not.toContain('HBgMOTIz');
  });
});
