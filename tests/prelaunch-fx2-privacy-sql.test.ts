// api-security-4 on the whole migration chain: erase_conversation and conversation_records in
// 202610200001_prelaunch_fixes.sql export and erase a customer known only by a chat (a WhatsApp
// privacy ID), removing what erase_customer removes for a number.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createConversation, processTurn } from '../src/domain/engine';
import { makeJob } from '../server/jobs';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import type { BotAction, Conversation, Job, Order } from '../src/shared/types';
import { migratedDb } from './helpers/migrated-db';

const company = seedCompanies[0]!;
const other = seedCompanies[1]!;
const products = seedProducts.filter((p) => p.companyId === company.id);
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60000).toISOString();
const DENIED = /permission denied for function/;
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
async function chat(phone: string, extra: Partial<Conversation> = {}, companyId = company.id) {
  const c = {
    ...createConversation(companyId, `${phone}:${randomUUID()}`, 'whatsapp', minutesAgo(60)),
    customerPhone: phone,
    ...extra,
    version: 1,
  };
  expect(await rpc('save_conversation', [c, 0])).toBe(true);
  return c;
}
const lid = (peer: string, generation = 1, extra: Partial<Conversation> = {}) =>
  chat('', { whatsappAddress: address(peer, generation), ...extra });
const exists = async (id: string) =>
  (await scalar<number>('select count(*)::int as value from conversations where id=$1', [id])) ===
  1;
const pauseBot = () =>
  t.db.query("update companies set data=jsonb_set(data,'{botEnabled}','false') where id=$1", [
    company.id,
  ]);

describe('api-security-4: erase_conversation and conversation_records', () => {
  async function placedOrder(c: Conversation) {
    let next: Conversation = c;
    const turn = (action: BotAction) => {
      const result = processTurn(company, products, next, {
        messageId: randomUUID(),
        text: action.type === 'confirm' ? 'confirm' : 'test',
        action,
        now: new Date().toISOString(),
      });
      next = result.conversation;
      return result;
    };
    turn({ type: 'add_item', productId: products[0]!.id, quantity: 1 });
    turn({ type: 'set_details', customerName: 'Privacy Customer', fulfillment: 'pickup' });
    turn({ type: 'review' });
    const result = turn({ type: 'confirm' });
    result.conversation.version = c.version + 1;
    expect(
      await rpc('commit_turn', [
        company.id,
        result.conversation,
        c.version,
        result.order,
        [],
        null,
      ]),
    ).toBe(true);
    return result.order!;
  }

  it('erases the chat, the same privacy ID’s other chats, their orders, jobs and traces', async () => {
    const target = await lid('100000009@lid');
    const order = await placedOrder(target);
    const again = await lid('100000009@lid', 2);
    const bystander = await lid('100000010@lid');
    const otherBusiness = await chat(
      '',
      { whatsappAddress: address('100000009@lid', 7) },
      other.id,
    );
    const job = {
      ...makeJob(company.id, 'incoming', {
        phone: '',
        whatsappAddress: address('100000009@lid'),
        streamKey: `${connectionId}:1:100000009@lid`,
        messageId: 'wamid-lid-1',
        text: 'House 4, Street 9',
      }),
      status: 'done' as const,
    };
    expect(await rpc('insert_job', [job, null])).toBe(true);
    const otherJob = makeJob(company.id, 'incoming', {
      phone: '',
      whatsappAddress: address('100000010@lid'),
      streamKey: `${connectionId}:1:100000010@lid`,
      messageId: 'wamid-lid-2',
      text: 'hello',
    });
    expect(await rpc('insert_job', [otherJob, null])).toBe(true);
    const traceId = randomUUID();
    await t.db.query(
      'insert into traces(id,company_id,conversation_id,created_at,data) values($1,$2,$3,now(),$4)',
      [
        traceId,
        company.id,
        target.id,
        { id: traceId, companyId: company.id, conversationId: target.id, action: 'x', detail: 'y' },
      ],
    );

    const records = await rpc<{ conversations: Conversation[]; orders: Order[] }>(
      'conversation_records',
      [company.id, target.id],
    );
    expect(records.conversations.map((c) => c.id).sort()).toEqual([target.id, again.id].sort());
    expect(records.orders.map((o) => o.id)).toEqual([order.id]);

    // Automation must be paused first, as for erasing by number.
    await expect(rpc('erase_conversation', [company.id, target.id])).rejects.toThrow(
      'Pause automation and wait for running work before deleting customer data',
    );
    await pauseBot();
    expect(await rpc('erase_conversation', [company.id, target.id])).toBe(2);
    expect(await exists(target.id)).toBe(false);
    expect(await exists(again.id)).toBe(false);
    expect(await exists(bystander.id)).toBe(true);
    expect(await exists(otherBusiness.id)).toBe(true);
    expect(await scalar('select count(*)::int as value from orders where id=$1', [order.id])).toBe(
      0,
    );
    expect(await scalar<Job>('select data as value from jobs where id=$1', [job.id])).toMatchObject(
      { status: 'done', payload: {} },
    );
    expect(
      (await scalar<Job>('select data as value from jobs where id=$1', [otherJob.id])).payload,
    ).toMatchObject({ text: 'hello' });
    expect(await scalar('select count(*)::int as value from traces where id=$1', [traceId])).toBe(
      0,
    );
    // Gone: nothing more to export or erase.
    expect(await rpc('conversation_records', [company.id, target.id])).toEqual({
      conversations: [],
      orders: [],
    });
    expect(await rpc('erase_conversation', [company.id, target.id])).toBe(0);
  });

  it('also takes every chat with the chat’s number, as erase_customer does', async () => {
    const linked = await chat('+923001234567', {
      whatsappAddress: address('923001234567@s.whatsapp.net'),
    });
    const meta = await chat('923001234567');
    const unrelated = await chat('923007654321');
    const ids = (
      await rpc<{ conversations: Conversation[] }>('conversation_records', [company.id, linked.id])
    ).conversations.map((c) => c.id);
    expect(ids.sort()).toEqual([linked.id, meta.id].sort());
    await pauseBot();
    expect(await rpc('erase_conversation', [company.id, linked.id])).toBe(2);
    expect(await exists(unrelated.id)).toBe(true);
  });

  it('leaves erasing by number as it was', async () => {
    const a = await chat('923001234567');
    const b = await chat('+923001234567', {
      whatsappAddress: address('923001234567@s.whatsapp.net'),
    });
    const privacy = await lid('100000020@lid');
    await pauseBot();
    expect(await rpc('erase_customer', [company.id, '+92 300 1234567'])).toBe(2);
    expect(await exists(a.id)).toBe(false);
    expect(await exists(b.id)).toBe(false);
    // A chat without a number is never reached by a number.
    expect(await exists(privacy.id)).toBe(true);
    await expect(rpc('erase_customer', [company.id, ' '])).rejects.toThrow(
      'Customer phone number required',
    );
  });

  it.each(['anon', 'authenticated'])('is for the server only, never %s', async (role) => {
    for (const signature of [
      'public.erase_conversation(text,text)',
      'public.conversation_records(text,text)',
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
    // The parts that erase without the checks are not callable at all, not even by the server.
    for (const signature of [
      'public.erase_customer_chats(text,text[],text)',
      'public.conversation_customer_ids(text,text)',
    ])
      for (const who of [role, 'service_role'])
        expect(
          await scalar(`select has_function_privilege($1,$2,'EXECUTE') as value`, [who, signature]),
          `${who} ${signature}`,
        ).toBe(false);
    await t.db.exec(`set role ${role}`);
    try {
      await expect(rpc('erase_conversation', [company.id, 'x'])).rejects.toThrow(DENIED);
    } finally {
      await t.db.exec('reset role');
    }
  });
});
