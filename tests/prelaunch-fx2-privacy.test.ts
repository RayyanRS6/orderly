// api-security-4: a customer whose chat arrived as a WhatsApp privacy ID (no number shared) can be
// exported and erased from their chat: GET /privacy/customer?conversationId= and POST
// /privacy/erase {conversationId}. Local demo store, no network.
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeJob } from '../server/jobs';
import { createConversation } from '../src/domain/engine';
import type { Conversation } from '../src/shared/types';
import type { WhatsAppAddress } from '../src/shared/whatsapp';
import { company, demoApp, minutesAgo } from './helpers/demo-app';

const app = demoApp();
const repo = () => app.repo();

describe('api-security-4: a customer known only by a chat (privacy ID)', () => {
  const connectionId = '5f0c9a59-3c1e-4c55-9c7c-2f3d1a4b5c6d';
  const address = (peer: string, generation = 1): WhatsAppAddress => ({
    connectionId,
    generation,
    provider: 'baileys',
    peer,
  });
  async function lidChat(peer: string, generation = 1, phone = '') {
    const c: Conversation = {
      ...createConversation(
        company.id,
        `${connectionId}:${generation}:${peer}`,
        'whatsapp',
        minutesAgo(30),
      ),
      customerPhone: phone,
      whatsappAddress: address(peer, generation),
      messages: [{ id: randomUUID(), role: 'customer', text: 'hi', createdAt: minutesAgo(30) }],
      version: 1,
    };
    expect(await repo().saveConversation(c, 0)).toBe(true);
    return c;
  }
  const exportOf = (query: string) => app.request(`/privacy/customer?${query}`);
  const erase = (body: Record<string, unknown>) =>
    app.request('/privacy/erase', { body: { externalCopiesAcknowledged: true, ...body } });
  const audits = async () => (await repo().listTraces(company.id)).map((t) => t.action);

  it('exports and erases the chat and the same privacy ID’s other chats, nothing else', async () => {
    await repo().saveCompany({ ...company, botEnabled: false });
    const target = await lidChat('100000009@lid');
    // The same person after the linked phone reconnected (a new connection generation).
    const again = await lidChat('100000009@lid', 2);
    const other = await lidChat('100000010@lid');
    const job = makeJob(company.id, 'incoming', {
      phone: '',
      whatsappAddress: target.whatsappAddress,
      streamKey: `${connectionId}:1:100000009@lid`,
      messageId: 'wamid-lid',
      text: 'my address is House 4',
    });
    await repo().insertJob(job);

    const exported = await exportOf(`conversationId=${target.id}`);
    expect(exported.status).toBe(200);
    const data = (await exported.json()) as { conversations: Conversation[]; orders: unknown[] };
    expect(data.conversations.map((c) => c.id).sort()).toEqual([target.id, again.id].sort());
    expect(data.conversations.find((c) => c.id === target.id)!.messages.map((m) => m.text)).toEqual(
      ['hi'],
    );
    expect(await audits()).toContain('privacy.customer_exported');

    const erased = await erase({ conversationId: target.id });
    expect(erased.status).toBe(200);
    expect(await erased.json()).toEqual({ deleted: 2 });
    expect(await repo().getConversation(company.id, target.id)).toBeUndefined();
    expect(await repo().getConversation(company.id, again.id)).toBeUndefined();
    expect(await repo().getConversation(company.id, other.id)).toBeDefined();
    expect(await repo().getJob(job.id)).toBeUndefined();
    expect(await audits()).toContain('privacy.customer_erased.2');
    // Asked again: nothing is left.
    const gone = await erase({ conversationId: target.id });
    expect(gone.status).toBe(404);
    expect((await gone.json()).error).toBe(
      'No records found for this chat. It may have been deleted already.',
    );
    expect((await exportOf(`conversationId=${target.id}`)).status).toBe(404);
    expect(await audits()).toContain('privacy.customer_erased.0');
  });

  it('also erases every chat with the chat’s number when it has one', async () => {
    await repo().saveCompany({ ...company, botEnabled: false });
    const linked = await lidChat('923001234567@s.whatsapp.net', 1, '+923001234567');
    const meta: Conversation = {
      ...createConversation(company.id, '923001234567', 'whatsapp', minutesAgo(60)),
      version: 1,
    };
    await repo().saveConversation(meta, 0);
    const erased = await erase({ conversationId: linked.id });
    expect(await erased.json()).toEqual({ deleted: 2 });
    expect(await repo().getConversation(company.id, meta.id)).toBeUndefined();
  });

  it('needs the number or the chat, not both, and automation paused', async () => {
    const target = await lidChat('100000011@lid');
    for (const body of [{}, { phone: '0300 1234567', conversationId: target.id }]) {
      const response = await erase(body);
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe(
        'Give the customer’s number or one of their chats (one of the two).',
      );
    }
    expect(
      (await exportOf(`phone=03001234567&conversationId=${encodeURIComponent(target.id)}`)).status,
    ).toBe(400);
    expect((await exportOf('')).status).toBe(400);
    // The seed business has its bot on: erasing waits until it is paused.
    await repo().saveCompany({ ...company, botEnabled: true });
    expect((await erase({ conversationId: target.id })).status).toBe(409);
    expect(await repo().getConversation(company.id, target.id)).toBeDefined();
  });
});
