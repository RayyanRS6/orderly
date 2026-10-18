// The in-memory store (local demo and tests) gives the same answers as the pre-launch SQL fixes.
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MemoryRepository } from '../server/repository';
import { makeJob } from '../server/jobs';
import { createConversation, processTurn } from '../src/domain/engine';
import { AI_LIMIT_DEFAULTS, effectiveAiLimits } from '../src/shared/models';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import type { BotAction, Company, Conversation, Job, Message } from '../src/shared/types';

const company = seedCompanies[0]!;
const products = seedProducts.filter((p) => p.companyId === company.id);
const now = () => new Date().toISOString();
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60000).toISOString();
const hourStart = () => Math.floor(Date.now() / 3600000) * 3600000;
const hourKey = () => new Date(hourStart()).toISOString().slice(0, 13);
let repo: MemoryRepository;
let phones = 0;
const nextPhone = () => `+9230022${String(++phones).padStart(5, '0')}`;

beforeEach(async () => {
  repo = new MemoryRepository(false);
  await repo.saveCompany({ ...company, botEnabled: true });
  await repo.replaceProducts(company.id, products);
  // Counts by clock hour would straddle two hours if a test began in an hour's last seconds.
  const left = 3600000 - (Date.now() % 3600000);
  if (left < 5000) await new Promise((resolve) => setTimeout(resolve, left + 100));
});

async function chat(
  phone: string,
  extra: Partial<Conversation> = {},
  channel: Conversation['channel'] = 'whatsapp',
) {
  const c = { ...createConversation(company.id, phone, channel, now()), ...extra, version: 1 };
  expect(await repo.saveConversation(c, 0)).toBe(true);
  return c;
}
async function settings(change: Partial<Company>) {
  await repo.saveCompany({ ...(await repo.getCompany(company.id))!, ...change });
}

describe('erasing a customer, in memory (F11, F69)', () => {
  const connection = '756bc31b-63af-4ce9-8324-1fd87803ae71';
  const address = (peer: string) => ({
    connectionId: connection,
    generation: 2,
    provider: 'baileys' as const,
    peer,
  });
  const stream = (peer: string) => `${connection}:2:${peer}`;

  it('finds every format of a whole number on WhatsApp, with its jobs and its block', async () => {
    const meta = await chat('923001234567');
    const linked = await chat('+923001234567', { whatsappAddress: address('100000001@lid') });
    const demo = await chat('923001234567', {}, 'demo');
    const unknownNumber = await chat('', { whatsappAddress: address('100000002@lid') });
    const someoneElse = await chat('+923007654321');
    const erased = [
      makeJob(company.id, 'incoming', { phone: '923001234567', text: 'private' }),
      makeJob(company.id, 'incoming', {
        phone: '',
        streamKey: stream('100000001@lid'),
        whatsappAddress: address('100000001@lid'),
        text: 'private, number not known yet',
      }),
      makeJob(company.id, 'whatsapp_send', { conversationId: linked.id, text: 'hi' }),
    ];
    const kept = [
      makeJob(company.id, 'incoming', { phone: '', streamKey: stream('100000002@lid'), text: 'a' }),
      makeJob(company.id, 'incoming', { phone: '+923007654321', text: 'b' }),
    ];
    for (const job of [...erased, ...kept]) await repo.insertJob(job);
    await repo.blockCustomer(company.id, meta.id, 'block-1', ['pn:923001234567'], 'Zainab', 'o');
    expect(await repo.findBlockedCustomer(company.id, ['lid:100000001', 'pn:923001234567'])).toBe(
      'block-1',
    );
    await repo.saveCompany({ ...(await repo.getCompany(company.id))!, botEnabled: false });

    expect(await repo.eraseCustomer(company.id, '+92 300 1234567')).toBe(2);
    expect((await repo.listConversations(company.id)).map((c) => c.id).sort()).toEqual(
      [demo.id, unknownNumber.id, someoneElse.id].sort(),
    );
    for (const job of erased) expect(await repo.getJob(job.id)).toBeUndefined();
    for (const job of kept) expect(await repo.getJob(job.id)).toBeDefined();
    const [blocked] = await repo.listBlockedCustomers(company.id);
    expect(blocked).toMatchObject({
      blockId: 'block-1',
      label: 'Erased customer',
      keys: ['lid:100000001', 'pn:923001234567'],
    });
    expect(blocked!.conversationId).toBeUndefined();
    expect(await repo.findBlockedCustomer(company.id, ['pn:923001234567'])).toBe('block-1');
  });

  it('never compares digits for a partial or empty number', async () => {
    await chat('', { whatsappAddress: address('100000003@lid') });
    await chat('923001234567');
    await repo.saveCompany({ ...(await repo.getCompany(company.id))!, botEnabled: false });
    for (const typed of ['++++', '1234', '0300 1234567', '92300123'])
      expect(await repo.eraseCustomer(company.id, typed), typed).toBe(0);
    await expect(repo.eraseCustomer(company.id, '  ')).rejects.toThrow(
      'Customer phone number required',
    );
    expect(await repo.listConversations(company.id)).toHaveLength(2);
  });
});

describe('staff alerts, in memory (G7.7, G5.1, G4.2)', () => {
  const message = (role: Message['role'], text: string, extra: Partial<Message> = {}): Message => ({
    id: randomUUID(),
    role,
    text,
    createdAt: now(),
    ...extra,
  });
  const human = (messages: Message[]) =>
    chat(nextPhone(), { mode: 'human', messages, updatedAt: minutesAgo(30) });
  const asked = () => message('customer', 'Please cancel my order');

  it('keeps a waiting customer in the bell and email alerts after an order status change', async () => {
    await human([
      asked(),
      message('staff', 'Calling you now'),
      message('staff', 'Order ORD-1 is now ready.', { notice: true }),
    ]);
    expect(await repo.staffAttention(company.id)).toMatchObject({ handoffs: 0, total: 0 });
    expect(await repo.hasOverdueAttention(company.id, 10)).toBe(false);
    const waiting = [
      await human([asked(), message('staff', 'Order ORD-2 is now preparing.', { notice: true })]),
      await human([asked(), message('staff', 'Order ORD-3 is now out for delivery.')]),
      await human([asked(), message('assistant', 'Order ORD-4 is now ready.', { notice: true })]),
    ];
    const alerts = await repo.staffAttention(company.id);
    expect(alerts.handoffs).toBe(3);
    expect(alerts.items.map((a) => a.entityId).sort()).toEqual(waiting.map((c) => c.id).sort());
    expect(await repo.hasOverdueAttention(company.id, 10)).toBe(true);
  });

  it('asks for an email about an order waiting 15 minutes, whatever the alert delay', async () => {
    let conversation = createConversation(company.id, nextPhone(), 'whatsapp', now());
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
    turn({ type: 'add_item', productId: products[0]!.id, quantity: 1 });
    turn({ type: 'set_details', customerName: 'Test Customer', fulfillment: 'pickup' });
    turn({ type: 'review' });
    const { order } = turn({ type: 'confirm' });
    conversation.version = 1;
    expect(await repo.commitTurn(company.id, conversation, 0, order)).toBe(true);
    await repo.saveOrder({ ...order!, createdAt: minutesAgo(14) });
    expect(await repo.hasOverdueAttention(company.id, 60)).toBe(false);
    await repo.saveOrder({ ...order!, createdAt: minutesAgo(16) });
    expect(await repo.hasOverdueAttention(company.id, 60)).toBe(true);
  });

  it('warns at 80% of the hourly AI replies until the limit is reached', async () => {
    const replies = (count: number) =>
      Promise.all(
        Array.from({ length: count }, () =>
          repo.addUsage({
            id: randomUUID(),
            companyId: company.id,
            provider: 'anthropic',
            model: 'claude-haiku-5-5',
            inputTokens: 1,
            outputTokens: 1,
            costUsd: 0.0001,
            createdAt: now(),
            conversationId: `chat-${randomUUID()}`,
          }),
        ),
      );
    await settings({ aiLimits: { repliesPerHour: 20 } });
    await replies(15);
    expect(await repo.staffAttention(company.id)).toMatchObject({ total: 0 });
    await replies(1);
    const warned = await repo.staffAttention(company.id);
    expect(warned).toMatchObject({ total: 1, limits: 0 });
    expect(warned.items).toEqual([
      {
        id: `limit:hourly_near:${hourKey()}`,
        kind: 'limit',
        entityId: company.id,
        createdAt: new Date(hourStart()).toISOString(),
        scope: 'hourly_near',
        resetsAt: new Date(hourStart() + 3600000).toISOString(),
      },
    ]);
    expect(await repo.hasOverdueAttention(company.id, 10)).toBe(true);
    await replies(4);
    expect(
      await repo.reserveAiCall(company.id, 'over', 0.0001, minutesAgo(-1), 'chat-x'),
    ).toMatchObject({ ok: false, limit: 'hourly' });
    const reached = await repo.staffAttention(company.id);
    expect(reached).toMatchObject({ total: 1, limits: 1 });
    expect(reached.items.map((a) => a.id)).toEqual([`limit:hourly:${hourKey()}`]);
  });

  it('defaults to 1,500 AI replies an hour and 100 per customer', () => {
    expect(effectiveAiLimits()).toEqual({
      repliesPerHour: 1500,
      repliesPerCustomerPerHour: 100,
      messagesPerCustomerPerMinute: 25,
    });
    expect(AI_LIMIT_DEFAULTS).toEqual(effectiveAiLimits());
  });
});

describe('pipeline health, in memory (F02)', () => {
  const job = (id: string, changes: Partial<Job> = {}, kind: Job['kind'] = 'whatsapp_send') => ({
    ...makeJob(company.id, kind, kind === 'incoming' ? { phone: '', streamKey: 's-1' } : {}, id),
    nextRunAt: minutesAgo(5),
    ...changes,
  });

  it('counts saved work due over 3 minutes ago, except behind a failed message', async () => {
    expect(await repo.pipelineHealth()).toMatchObject({
      status: 'ok',
      stalledJobs: 0,
      oldestDueAt: null,
    });
    await repo.insertJob(job('stalled'));
    await repo.insertJob(job('just-due', { nextRunAt: minutesAgo(1) }));
    await repo.insertJob(job('exhausted', { attempts: 5 }));
    await repo.insertJob(job('failed-head', { status: 'failed' }, 'incoming'));
    await repo.insertJob(job('behind-failure', {}, 'incoming'));
    const health = await repo.pipelineHealth();
    expect(health).toMatchObject({ status: 'stalled', stalledJobs: 1, schedulerConfigured: true });
    expect(Date.parse(health.oldestDueAt!)).toBeLessThan(Date.now() - 4 * 60000);
    expect(health.dbSizeBytes).toBeGreaterThan(0);
  });

  it('ends waiting order reminders when WhatsApp is disconnected', async () => {
    // The job kind is added to the shared type with its worker (another change).
    const reminder = job('reminder', {}, 'order_followup' as unknown as Job['kind']);
    await repo.insertJob(reminder);
    await repo.disconnectIntegration(company.id, 'whatsapp');
    expect(await repo.getJob('reminder')).toMatchObject({ status: 'done', payload: {} });
  });
});
