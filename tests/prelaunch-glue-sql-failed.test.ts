// A message that failed for good goes into its chat when the database finishes its job (F17),
// as the worker does: fail_exhausted_orderly_jobs in 202610200001_prelaunch_fixes.sql.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createConversation } from '../src/domain/engine';
import { makeJob } from '../server/jobs';
import { seedCompanies } from '../src/shared/seed';
import type { Conversation, Job, StaffAttention } from '../src/shared/types';
import { migratedDb } from './helpers/migrated-db';

const company = seedCompanies[0]!;
const workerUrl = 'https://abcdefghijklmnopqrst.supabase.co/functions/v1/orderly/api/jobs/process';
const workerToken = 'test-worker-token-for-glue-checks-1234567890';
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60000).toISOString();
let t: Awaited<ReturnType<typeof migratedDb>>;
const scalar = <T = unknown>(text: string, args: unknown[] = []) => t.scalar<T>(text, args);
const rpc = <T = unknown>(name: string, args: unknown[] = []) => t.rpc<T>(name, args);
const attention = () => rpc<StaffAttention>('staff_attention', [company.id]);
let phones = 0;
const nextPhone = () => `+9230022${String(++phones).padStart(5, '0')}`;
async function chat(phone: string, extra: Partial<Conversation> = {}) {
  const c = {
    ...createConversation(company.id, phone, 'whatsapp', minutesAgo(60)),
    ...extra,
    version: 1,
  };
  expect(await rpc('save_conversation', [c, 0])).toBe(true);
  return c;
}
const conversation = (id: string) =>
  scalar<Conversation>('select data as value from conversations where id=$1', [id]);
const jobData = (id: string) => scalar<Job>('select data as value from jobs where id=$1', [id]);
beforeAll(async () => {
  t = await migratedDb();
}, 30000);
beforeEach(() => t.reset());
afterAll(() => t.db.close());

describe('a message that failed for good goes into its chat (F17)', () => {
  const configure = () => rpc('configure_orderly_scheduler', [workerUrl, workerToken]);
  async function exhausted(payload: Record<string, unknown>, createdAt = minutesAgo(30)) {
    const job = { ...makeJob(company.id, 'incoming', payload), createdAt, nextRunAt: createdAt };
    expect(await rpc('insert_job', [job, null])).toBe(true);
    await t.db.query(
      `update jobs set attempts=5,status='processing',lease_until=now()-interval '1 minute',
         data=data||'{"attempts":5,"status":"processing"}'::jsonb where id=$1`,
      [job.id],
    );
    return job;
  }
  const dispatched = async () =>
    (
      await t.db.query<{ id: string }>("select body->>'jobId' as id from net.http_request_queue")
    ).rows.map((r) => r.id);

  it('appends the message, hands the chat to staff and frees the messages behind it', async () => {
    await configure();
    const phone = nextPhone();
    const c = await chat(phone, {
      limitPause: { at: minutesAgo(40), until: minutesAgo(-20), reason: 'customer', limit: 100 },
      lastInboundAt: minutesAgo(50),
    });
    const failed = await exhausted({ phone, messageId: 'wamid-failed', text: 'I want 2 biryani' });
    const next = makeJob(company.id, 'incoming', {
      phone,
      messageId: 'wamid-next',
      text: 'hello?',
    });
    await rpc('insert_job', [next, null]);
    expect(await rpc('fail_exhausted_orderly_jobs', [20])).toBe(1);

    expect(await jobData(failed.id)).toMatchObject({
      status: 'done',
      payload: {
        phone,
        messageId: 'wamid-failed',
        text: 'I want 2 biryani',
        failedPermanently: true,
      },
    });
    expect(await scalar('select status as value from jobs where id=$1', [failed.id])).toBe('done');
    const saved = await conversation(c.id);
    expect(saved).toMatchObject({ mode: 'human', version: 2, lastInboundAt: failed.createdAt });
    expect(saved).not.toHaveProperty('limitPause');
    expect(saved).not.toHaveProperty('botPausedAt');
    expect(saved.messages.at(-1)).toEqual({
      id: 'wamid-failed',
      role: 'customer',
      text: 'I want 2 biryani',
      createdAt: failed.createdAt,
    });
    expect(
      await scalar(
        'select count(*)::int as value from conversation_messages where conversation_id=$1 and id=$2',
        [c.id, 'wamid-failed'],
      ),
    ).toBe(1);
    // The customer's next message is sent to the worker straight away.
    expect(await dispatched()).toEqual([next.id]);
    // Staff see the chat, not a failed job.
    expect(await attention()).toMatchObject({ failures: 0, handoffs: 1 });
    expect(
      await scalar(
        "select data->>'detail' as value from traces where data->>'action'='job.failed'",
      ),
    ).toContain('in the chat for staff');
    expect(await rpc('fail_exhausted_orderly_jobs', [20])).toBe(0);
  });

  it('finds a linked-phone chat by its address, keeps a staff echo as staff and never duplicates', async () => {
    const address = {
      connectionId: '756bc31b-63af-4ce9-8324-1fd87803ae71',
      generation: 2,
      provider: 'baileys' as const,
      peer: '100000009@lid',
    };
    const inbound = minutesAgo(10);
    const c = await chat('', {
      whatsappAddress: address,
      lastInboundAt: inbound,
      messages: [{ id: 'wamid-seen', role: 'customer', text: 'menu', createdAt: inbound }],
    });
    const stream = `${address.connectionId}:2:${address.peer}`;
    const echo = await exhausted({
      phone: '',
      whatsappAddress: address,
      streamKey: stream,
      messageId: 'wamid-echo',
      text: 'Coming right up',
      echo: true,
    });
    const seen = await exhausted({
      phone: '',
      whatsappAddress: address,
      streamKey: stream,
      messageId: 'wamid-seen',
      text: 'menu',
    });
    expect(await rpc('fail_exhausted_orderly_jobs', [20])).toBe(2);
    for (const job of [echo, seen])
      expect(await jobData(job.id)).toMatchObject({
        status: 'done',
        payload: { failedPermanently: true },
      });
    const saved = await conversation(c.id);
    expect(saved.messages.map((m) => [m.id, m.role])).toEqual([
      ['wamid-seen', 'customer'],
      ['wamid-echo', 'staff'],
    ]);
    // A staff message does not reopen the customer's reply window.
    expect(saved.lastInboundAt).toBe(inbound);
    expect(saved.mode).toBe('human');
  });

  it('keeps the job failed for a blocked number or a chat that does not exist', async () => {
    const phone = nextPhone();
    const c = await chat(phone);
    await scalar(
      'select public.block_customer(p_company_id=>$1,p_conversation_id=>$2,p_block_id=>$3,p_keys=>$4,p_label=>$5,p_actor_id=>$6) as value',
      [company.id, c.id, 'block-1', [`pn:${phone.slice(1)}`], 'Spam', 'owner'],
    );
    const before = await conversation(c.id);
    const blocked = await exhausted({ phone, messageId: 'wamid-b', text: 'spam' });
    const nowhere = await exhausted({ phone: nextPhone(), messageId: 'wamid-n', text: 'hi' });
    expect(await rpc('fail_exhausted_orderly_jobs', [20])).toBe(2);
    for (const job of [blocked, nowhere]) {
      expect(await jobData(job.id)).toMatchObject({ status: 'failed' });
      expect((await jobData(job.id)).payload).not.toHaveProperty('failedPermanently');
    }
    expect(await conversation(c.id)).toEqual(before);
    expect(await attention()).toMatchObject({ failures: 2 });
  });

  it.each(['anon', 'authenticated'])('is for the server only, never %s', async (role) => {
    const signature = 'public.fail_exhausted_orderly_jobs(integer)';
    expect(
      await scalar(`select has_function_privilege($1,$2,'EXECUTE') as value`, [role, signature]),
    ).toBe(false);
    expect(
      await scalar(`select has_function_privilege('service_role',$1,'EXECUTE') as value`, [
        signature,
      ]),
    ).toBe(true);
  });
});
