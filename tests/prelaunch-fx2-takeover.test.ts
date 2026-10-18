// The takeover clock: when staff take a chat over from the bot, the customer counts as waiting
// for staff from the takeover at the earliest (humanSince), not from a message the bot answered
// hours before. Local demo store, no network.
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createConversation } from '../src/domain/engine';
import type { Conversation, StaffAttention } from '../src/shared/types';
import { company, demoApp, minutesAgo } from './helpers/demo-app';

const app = demoApp();
const repo = () => app.repo();

describe('the takeover clock: a chat staff take over waits from the takeover', () => {
  async function answeredChat() {
    const asked = minutesAgo(120);
    const c: Conversation = {
      ...createConversation(company.id, '923001119999', 'whatsapp', asked),
      messages: [
        { id: randomUUID(), role: 'customer', text: 'Do you deliver to DHA?', createdAt: asked },
        { id: randomUUID(), role: 'assistant', text: 'Yes, we do.', createdAt: asked },
      ],
      updatedAt: asked,
      version: 1,
    };
    expect(await repo().saveConversation(c, 0)).toBe(true);
    return c;
  }
  const itemFor = async (c: Conversation) =>
    ((await (await app.request('/attention')).json()) as StaffAttention).items.find(
      (a) => a.id === `handoff:${c.id}`,
    );
  const setMode = (c: Conversation, mode: 'bot' | 'human') =>
    app.request(`/conversations/${c.id}/mode`, { body: { mode } });

  it('counts from the takeover, not from the message the bot answered hours ago', async () => {
    const c = await answeredChat();
    const before = Date.now();
    const taken = await setMode(c, 'human');
    expect(taken.status).toBe(200);
    const saved = (await taken.json()) as Conversation;
    expect(Date.parse(saved.humanSince!)).toBeGreaterThanOrEqual(before);
    expect((await itemFor(c))?.createdAt).toBe(saved.humanSince);
    // A customer message after the takeover counts from that message.
    const current = (await repo().getConversation(company.id, c.id))!;
    const later = new Date(Date.now() + 1000).toISOString();
    await repo().saveConversation(
      {
        ...current,
        messages: [
          ...current.messages,
          { id: randomUUID(), role: 'customer', text: 'Hello?', createdAt: later },
        ],
        updatedAt: new Date(Date.now() + 2000).toISOString(),
        version: current.version + 1,
      },
      current.version,
    );
    expect((await itemFor(c))?.createdAt).toBe(later);
  });

  it('clears it when the chat goes back to the bot, and keeps the clock of a chat already with staff', async () => {
    const c = await answeredChat();
    await setMode(c, 'human');
    const back = (await (await setMode(c, 'bot')).json()) as Conversation;
    expect(back.humanSince).toBeUndefined();
    // A chat the bot handed over: the customer has waited since their message.
    const current = (await repo().getConversation(company.id, c.id))!;
    await repo().saveConversation(
      { ...current, mode: 'human', version: current.version + 1 },
      current.version,
    );
    const again = (await (await setMode(c, 'human')).json()) as Conversation;
    expect(again.humanSince).toBeUndefined();
    expect((await itemFor(c))?.createdAt).toBe(c.messages[0]!.createdAt);
  });
});
