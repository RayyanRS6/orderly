// Fix package 7, API: the emergency stop also stops test chats and AI checks (ai-pipeline-1), and
// the order status notice waits for a running turn (ai-pipeline-2).
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Message, Order } from '../src/shared/types';
import { company, demoApp, placedOrder } from './helpers/demo-app';

const app = demoApp();

describe('ai-pipeline-1: the emergency stop also stops test chats and AI checks', () => {
  it.each([
    ['/chat', { messageId: 'm-1', text: 'menu' }],
    ['/models/test', {}],
    [
      '/ai/connect',
      {
        provider: 'openai',
        model: 'gpt-5.4-mini',
        apiKey: 'sk-test-key-0000000000',
        approve: true,
        attest: { noTrainingOptIn: true },
      },
    ],
  ])('answers %s with 503 and calls no AI provider', async (path, body) => {
    vi.stubEnv('ORDERLY_PAUSE_AUTOMATION', 'on');
    const before = await app.repo().getCompany(company.id);
    const response = await app.request(path, { body });
    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatch(/paused on Orderly right now/);
    expect(fetch).not.toHaveBeenCalled();
    expect(await app.repo().getCompany(company.id)).toEqual(before);
  });

  it('lets test chats run again once the stop is lifted', async () => {
    const response = await app.request('/chat', {
      body: { messageId: randomUUID(), text: 'menu', action: { type: 'menu' } },
    });
    expect(response.status).toBe(200);
  });
});

describe('ai-pipeline-2: the order status notice waits for a running turn', () => {
  const status = (order: Order, value: Order['status']) =>
    app.request(`/orders/${order.id}/status`, { body: { status: value } });
  const lease = () => new Date(Date.now() + 60000).toISOString();
  const reply = (text: string): Message => ({
    id: randomUUID(),
    role: 'assistant',
    text,
    createdAt: new Date().toISOString(),
  });

  it('writes its copy after the turn, so the turn’s answer is saved, not retried', async () => {
    const repo = app.repo();
    const { order, chat } = await placedOrder(repo);
    // A customer's turn holds the chat while the AI answers.
    expect(await repo.acquireConversationLock(company.id, chat.id, 'turn', lease())).toBe(true);
    const changing = status(order, 'rejected');
    await new Promise((resolve) => setTimeout(resolve, 700));
    const read = (await repo.getConversation(company.id, chat.id))!;
    expect(read.messages.some((m) => m.notice)).toBe(false);
    // The turn commits against the version it read.
    expect(
      await repo.saveConversation(
        { ...read, version: read.version + 1, messages: [...read.messages, reply('Raita added.')] },
        read.version,
      ),
    ).toBe(true);
    await repo.releaseConversationLock(company.id, chat.id, 'turn');
    expect((await changing).status).toBe(200);
    const saved = (await repo.getConversation(company.id, chat.id))!;
    expect(saved.messages.slice(-2).map((m) => [m.role, m.text, !!m.notice])).toEqual([
      ['assistant', 'Raita added.', false],
      ['staff', `Order ${order.reference} is now rejected.`, true],
    ]);
    // The route let the chat go again.
    expect(await repo.acquireConversationLock(company.id, chat.id, 'next', lease())).toBe(true);
  });

  it('still writes its copy when the chat stays busy', async () => {
    const repo = app.repo();
    const { order, chat } = await placedOrder(repo);
    expect(await repo.acquireConversationLock(company.id, chat.id, 'stuck', lease())).toBe(true);
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const changing = status(order, 'rejected');
      await vi.advanceTimersByTimeAsync(9000);
      expect((await changing).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
    const saved = (await repo.getConversation(company.id, chat.id))!;
    expect(saved.messages.at(-1)).toMatchObject({ role: 'staff', notice: true });
    // Never took over the other worker's lock.
    expect(await repo.acquireConversationLock(company.id, chat.id, 'next', lease())).toBe(false);
  });
});
