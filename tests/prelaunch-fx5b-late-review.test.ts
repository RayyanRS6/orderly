// A "confirm" that reaches Orderly late is answered with the order summary again. That summary
// is timed from when it was shown (the processing time), not from when the late message was
// sent, so the customer's next on-time "confirm" places the order even after an hour's delay.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeJob } from '../server/jobs';
import { MemoryRepository } from '../server/repository';
import { processJob } from '../server/service';
import { createConversation, processTurn } from '../src/domain/engine';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import type { BotAction, Conversation, Job, TurnInput } from '../src/shared/types';

const company = seedCompanies[0]!;
const products = seedProducts.filter((p) => p.companyId === company.id);
const biryani = products.find((p) => p.name === 'Chicken Biryani')!;
const steps: BotAction[] = [
  { type: 'add_item', productId: biryani.id, quantity: 1 },
  { type: 'set_details', customerName: 'Ali Raza', fulfillment: 'pickup' },
  { type: 'review' },
];

describe('the engine times a review by when it was shown', () => {
  // Wednesday 9 September 2026, 18:30 in Karachi (the demo restaurant is open all day).
  const now = '2026-09-09T13:30:00.000Z';
  const at = (minutes: number) => new Date(Date.parse(now) + minutes * 60000).toISOString();
  let message = 0;
  const turn = (c: Conversation, text: string, extra: Partial<TurnInput> = {}) =>
    processTurn(company, products, c, {
      messageId: `fx5b-late-${++message}`,
      text,
      now,
      ...extra,
    });
  // Reviewed 75 minutes ago.
  function reviewed() {
    let c = createConversation(company.id, '923000000603', 'demo', at(-80));
    for (const action of steps) c = turn(c, 'step', { action, now: at(-75) }).conversation;
    expect(c.cart).toMatchObject({ status: 'awaiting_confirmation', reviewedAt: at(-75) });
    return c;
  }

  it('lets the next on-time “confirm” place an order re-shown for a late one', () => {
    // Sent 70 minutes ago, processed now.
    const late = turn(reviewed(), 'confirm', { now: at(-70), late: true, receivedAt: now });
    expect(late.order).toBeUndefined();
    expect(late.traces).toContain('fresh_confirmation_required');
    expect(late.reply.startsWith('Sorry for the delay. Please confirm your order again.')).toBe(
      true,
    );
    expect(late.conversation.cart).toMatchObject({
      status: 'awaiting_confirmation',
      reviewedAt: now,
      reviewMessageId: `fx5b-late-${message}:reply`,
    });
    const next = turn(late.conversation, 'confirm', { now: at(1) });
    expect(next.order).toMatchObject({ status: 'pending' });
    expect(next.reply).toContain(`Order ${next.order!.reference} received`);
  });

  it('times an on-time review by its message, and ignores an unreadable processing time', () => {
    expect(turn(reviewed(), 'review', { now: at(-1) }).conversation.cart.reviewedAt).toBe(at(-1));
    expect(
      turn(reviewed(), 'review', { now: at(-1), receivedAt: 'soon' }).conversation.cart.reviewedAt,
    ).toBe(at(-1));
  });
});

describe('the worker gives a late message its processing time', () => {
  let repo: MemoryRepository;
  beforeEach(() => {
    repo = new MemoryRepository();
    vi.stubEnv('APP_MODE', 'demo');
    vi.stubEnv('ORDERLY_RUNTIME', '');
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('MODEL_PRICING_JSON', '');
    vi.stubEnv('WORKER_LEASE_SECONDS', '');
    vi.stubEnv('ORDERLY_PAUSE_AUTOMATION', '');
    vi.stubEnv('MENU_LINK_SECRET', '');
    vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('Unexpected network request'))),
    );
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60000).toISOString();
  const saved = async (c: Conversation) => (await repo.getConversation(company.id, c.id))!;
  let phones = 0;
  // A WhatsApp chat (demo rules, no AI) shown its order summary at `when`.
  async function reviewedChat(when: string) {
    const phone = `9230067${String(++phones).padStart(5, '0')}`;
    let c: Conversation = {
      ...createConversation(company.id, phone, 'whatsapp', '1970-01-01T00:00:00.000Z'),
      version: 0,
    };
    for (const action of steps)
      c = processTurn(company, products, c, {
        messageId: randomUUID(),
        text: 'step',
        action,
        now: when,
      }).conversation;
    c.version = 1;
    expect(await repo.commitTurn(company.id, c, 0)).toBe(true);
    return { conversation: await saved(c), phone };
  }
  // The customer's message as the worker handles it, sent this many minutes ago.
  async function incoming(phone: string, text: string, sentMinutesAgo = 0): Promise<Job> {
    const job: Job = {
      ...makeJob(company.id, 'incoming', { phone, messageId: `wamid.${randomUUID()}`, text }),
      createdAt: minutesAgo(sentMinutesAgo),
      nextRunAt: minutesAgo(sentMinutesAgo),
    };
    await repo.insertJob(job);
    await processJob(repo, job.id);
    expect((await repo.getJob(job.id))?.status).toBe('done');
    return job;
  }

  it('places the order on the “confirm” after one that arrived 70 minutes late', async () => {
    const { conversation, phone } = await reviewedChat(minutesAgo(75));
    const orders = async () =>
      (await repo.listOrders(company.id)).filter((o) => o.conversationId === conversation.id);
    const before = Date.now();
    await incoming(phone, 'confirm', 70);
    const late = await saved(conversation);
    expect(late.messages.at(-1)!.text).toContain(
      'Sorry for the delay. Please confirm your order again.',
    );
    expect(late.cart.status).toBe('awaiting_confirmation');
    expect(late.cart.reviewMessageId).toBe(late.messages.at(-1)!.id);
    expect(Date.parse(late.cart.reviewedAt!)).toBeGreaterThanOrEqual(before);
    expect(await orders()).toHaveLength(0);
    // The customer confirms the summary they were just shown.
    await incoming(phone, 'confirm');
    const [order, ...more] = await orders();
    expect(more).toHaveLength(0);
    expect(order).toMatchObject({ status: 'pending' });
    expect((await saved(conversation)).cart).toMatchObject({
      status: 'submitted',
      orderId: order!.id,
    });
  });

  it('still times an on-time message’s summary by the message itself', async () => {
    const { conversation, phone } = await reviewedChat(minutesAgo(5));
    const job = await incoming(phone, 'review', 2);
    expect((await saved(conversation)).cart.reviewedAt).toBe(job.createdAt);
  });
});
