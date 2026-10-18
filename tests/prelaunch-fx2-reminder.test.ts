// customer-wording-2 and ai-pipeline-5: the reminder for an order still waiting for the
// restaurant claims nothing about staff, offers "cancel" only when that would cancel exactly that
// order, and is written under the chat's lock like any turn.
import { describe, expect, it, vi } from 'vitest';
import { processJob } from '../server/service';
import type { Conversation } from '../src/shared/types';
import { company, turnStore } from './helpers/fx2-turns';

const { repo, say, waitingOrder, followup } = turnStore();
const reminders = async (c: Conversation) =>
  (await repo().getConversation(company.id, c.id))!.messages.filter((m) =>
    m.id.startsWith('order-followup:'),
  );
const sends = async () =>
  (await repo().listCompanyJobs(company.id)).filter((j) => j.kind === 'whatsapp_send');

describe('customer-wording-2 and ai-pipeline-5: the waiting-order reminder', () => {
  it('offers “cancel” only while cancelling would cancel exactly that order', async () => {
    const { conversation, order } = await waitingOrder();
    // The customer started a new order: their cart is no longer this order.
    await say(company, conversation, 'new order');
    expect(
      (await repo().getConversation(company.id, conversation.id))!.cart.orderId,
    ).toBeUndefined();
    const job = followup(order);
    await repo().insertJob(job);
    await processJob(repo(), job.id);
    const [reminder] = await reminders(conversation);
    expect(reminder!.text).toBe(
      `Your order ${order.reference} is still waiting for the restaurant to accept it. You’ll get a message here when they accept or decline it.`,
    );
    expect(reminder!.text).not.toMatch(/cancel/i);
    expect((await repo().getOrder(company.id, order.id))!.status).toBe('pending');
  });

  it('waits for a turn in progress instead of landing in the middle of it', async () => {
    const { conversation, order } = await waitingOrder();
    // A customer's message is being answered: its turn holds the chat.
    expect(
      await repo().acquireConversationLock(
        company.id,
        conversation.id,
        'turn-in-progress',
        new Date(Date.now() + 60000).toISOString(),
      ),
    ).toBe(true);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const job = followup(order);
    await repo().insertJob(job);
    await expect(processJob(repo(), job.id)).rejects.toMatchObject({ status: 503 });
    expect((await repo().getJob(job.id))!).toMatchObject({ status: 'pending' });
    expect(await reminders(conversation)).toHaveLength(0);
    expect((await repo().getConversation(company.id, conversation.id))!.version).toBe(
      conversation.version,
    );
    // Once the turn is done, the reminder goes.
    await repo().releaseConversationLock(company.id, conversation.id, 'turn-in-progress');
    await repo().saveJob({
      ...(await repo().getJob(job.id))!,
      nextRunAt: new Date().toISOString(),
    });
    await processJob(repo(), job.id);
    expect((await repo().getJob(job.id))!.status).toBe('done');
    expect(await reminders(conversation)).toHaveLength(1);
    // And the chat is free again for the customer's next message.
    expect(
      await repo().acquireConversationLock(
        company.id,
        conversation.id,
        'next-turn',
        new Date(Date.now() + 60000).toISOString(),
      ),
    ).toBe(true);
  });

  it('tests-ci-8: says nothing while automation is paused across Orderly', async () => {
    vi.stubEnv('ORDERLY_PAUSE_AUTOMATION', 'on');
    const { conversation, order } = await waitingOrder();
    const before = (await sends()).length;
    const job = followup(order);
    await repo().insertJob(job);
    await processJob(repo(), job.id);
    expect((await repo().getJob(job.id))!.status).toBe('done');
    expect(await reminders(conversation)).toHaveLength(0);
    expect(await sends()).toHaveLength(before);
  });
});
