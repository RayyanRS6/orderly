// An order status change staff make, as the chat records it (G5.1, G7.7).
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Order } from '../src/shared/types';
import { company, demoApp, placedOrder } from './helpers/demo-app';

const app = demoApp();

describe('order status changes in the chat (G5.1, G7.7)', () => {
  const status = (order: Order, value: Order['status']) =>
    app.request(`/orders/${order.id}/status`, { body: { status: value } });
  const sends = async () =>
    (await app.repo().listCompanyJobs(company.id)).filter((j) => j.kind === 'whatsapp_send');

  it('adds nothing when the status did not change', async () => {
    const repo = app.repo();
    const { order, chat } = await placedOrder(repo);
    const before = (await repo.getConversation(company.id, chat.id))!;
    const response = await status(order, 'pending');
    expect(response.status).toBe(200);
    expect((await repo.getConversation(company.id, chat.id))!).toEqual(before);
    expect(await sends()).toHaveLength(0);
    expect((await repo.getOrder(company.id, order.id))!.updatedAt).toBe(order.updatedAt);
  });

  it('writes the notice as automatic, so a customer waiting for staff still shows', async () => {
    const repo = app.repo();
    const { order, chat } = await placedOrder(repo);
    const waiting = {
      ...chat,
      mode: 'human' as const,
      version: chat.version + 1,
      messages: [
        ...chat.messages,
        {
          id: randomUUID(),
          role: 'customer' as const,
          text: 'Is my order coming?',
          createdAt: new Date().toISOString(),
        },
      ],
    };
    expect(await repo.saveConversation(waiting, chat.version)).toBe(true);
    expect((await status(order, 'rejected')).status).toBe(200);
    const saved = (await repo.getConversation(company.id, chat.id))!;
    expect(saved.messages.at(-1)).toMatchObject({
      role: 'staff',
      notice: true,
      text: `Order ${order.reference} is now rejected.`,
    });
    expect(await sends()).toHaveLength(1);
    const alerts = await repo.staffAttention(company.id);
    expect(alerts.items.map((a) => a.id)).toContain(`handoff:${chat.id}`);
  });

  it('reads the chat again when it changed meanwhile, and never fails a saved status', async () => {
    const repo = app.repo();
    const { order, chat } = await placedOrder(repo);
    const save = vi.spyOn(repo, 'saveConversation').mockResolvedValueOnce(false);
    expect((await status(order, 'cancelled')).status).toBe(200);
    expect(save).toHaveBeenCalledTimes(2);
    const notices = (await repo.getConversation(company.id, chat.id))!.messages.filter(
      (m) => m.notice,
    );
    expect(notices.map((m) => m.text)).toEqual([`Order ${order.reference} is now cancelled.`]);

    const other = await placedOrder(repo, '+923001110002');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    save.mockResolvedValue(false);
    const response = await status(other.order, 'rejected');
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe('rejected');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be added'));
  });
});
