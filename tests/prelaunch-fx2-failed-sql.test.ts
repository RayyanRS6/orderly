// F17 (ai-pipeline-6, tests-ci-3) on the whole migration chain: fail_exhausted_orderly_jobs in
// 202610200001_prelaunch_fixes.sql gives up on a customer's message as the worker does, so a
// customer's first failed message starts their chat instead of holding back their later ones.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeJob } from '../server/jobs';
import { seedCompanies } from '../src/shared/seed';
import type { Conversation, Job } from '../src/shared/types';
import { migratedDb } from './helpers/migrated-db';

const company = seedCompanies[0]!;
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60000).toISOString();
let t: Awaited<ReturnType<typeof migratedDb>>;
const scalar = <T = unknown>(text: string, args: unknown[] = []) => t.scalar<T>(text, args);
const rpc = <T = unknown>(name: string, args: unknown[] = []) => t.rpc<T>(name, args);
beforeAll(async () => {
  t = await migratedDb();
}, 30000);
beforeEach(() => t.reset());
afterAll(() => t.db.close());

const connectionId = '756bc31b-63af-4ce9-8324-1fd87803ae71';
const address = (peer: string, generation = 1) => ({
  connectionId,
  generation,
  provider: 'baileys' as const,
  peer,
});

describe('F17 (ai-pipeline-6, tests-ci-3): the database gives up on a message as the worker does', () => {
  async function exhausted(payload: Record<string, unknown>) {
    const createdAt = minutesAgo(30);
    const job = { ...makeJob(company.id, 'incoming', payload), createdAt, nextRunAt: createdAt };
    expect(await rpc('insert_job', [job, null])).toBe(true);
    await t.db.query(
      `update jobs set attempts=5,status='processing',lease_until=now()-interval '1 minute',
         data=data||'{"attempts":5,"status":"processing"}'::jsonb where id=$1`,
      [job.id],
    );
    return job;
  }
  const jobData = (id: string) => scalar<Job>('select data as value from jobs where id=$1', [id]);
  async function connect(generation: number, status = 'connected') {
    const connection = {
      id: connectionId,
      companyId: company.id,
      provider: 'baileys',
      generation,
      revision: 1,
      status,
      updatedAt: minutesAgo(60),
    };
    await t.db.query(
      'insert into whatsapp_connections(id,company_id,revision,data) values($1,$2,1,$3)',
      [connection.id, company.id, connection],
    );
  }

  it('starts the chat for a first message on the business’s current linked phone', async () => {
    await connect(3);
    const peer = '100000078@lid';
    const job = await exhausted({
      phone: '',
      whatsappAddress: address(peer, 3),
      streamKey: `${connectionId}:3:${peer}`,
      messageId: 'wamid-lid',
      text: 'menu please',
    });
    expect(await rpc('fail_exhausted_orderly_jobs', [20])).toBe(1);
    expect(await jobData(job.id)).toMatchObject({
      status: 'done',
      payload: { failedPermanently: true },
    });
    const started = await scalar<Conversation>(
      "select data as value from conversations where data->'whatsappAddress'->>'peer'=$1",
      [peer],
    );
    expect(started).toMatchObject({
      customerPhone: '',
      whatsappAddress: address(peer, 3),
      mode: 'human',
      version: 1,
    });
    expect(started.messages.map((m) => [m.id, m.text])).toEqual([['wamid-lid', 'menu please']]);
  });

  it('starts no chat for a message of a previous WhatsApp connection', async () => {
    await connect(3);
    const peer = '100000077@lid';
    const stale = await exhausted({
      phone: '',
      whatsappAddress: address(peer, 2),
      streamKey: `${connectionId}:2:${peer}`,
      messageId: 'wamid-old',
      text: 'hi',
    });
    // Nor for a message without an address once the business has a connection.
    const unbound = await exhausted({ phone: '923001119998', messageId: 'wamid-x', text: 'hi' });
    expect(await rpc('fail_exhausted_orderly_jobs', [20])).toBe(2);
    expect(await jobData(stale.id)).toMatchObject({ status: 'failed' });
    expect(await jobData(unbound.id)).toMatchObject({ status: 'failed' });
    expect(await scalar('select count(*)::int as value from conversations')).toBe(0);
  });

  it('starts no chat for a phone that was disconnected', async () => {
    await connect(3, 'disconnected');
    const peer = '100000079@lid';
    const job = await exhausted({
      phone: '',
      whatsappAddress: address(peer, 3),
      streamKey: `${connectionId}:3:${peer}`,
      messageId: 'wamid-off',
      text: 'hi',
    });
    expect(await rpc('fail_exhausted_orderly_jobs', [20])).toBe(1);
    expect(await jobData(job.id)).toMatchObject({ status: 'failed' });
  });
});
