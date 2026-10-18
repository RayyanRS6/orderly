// A customer export finds every chat erasing would remove (F11): the route and the local store,
// and the hosted store's call to the database.
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { SupabaseRepository } from '../server/storage/supabase';
import { PublicError } from '../server/security';
import { createConversation } from '../src/domain/engine';
import type { Conversation, Order } from '../src/shared/types';
import { company, demoApp, linkedPhone, minutesAgo, placedOrder } from './helpers/demo-app';

const client = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), auth: { admin: {} } }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => client }));

const app = demoApp();

describe('a customer export finds every chat erasing would remove (F11)', () => {
  it('includes every WhatsApp chat with the number, not only the newest per channel', async () => {
    const repo = app.repo();
    const address = (generation: number) => ({
      connectionId: linkedPhone().id,
      generation,
      provider: 'baileys' as const,
      peer: '923001234567@s.whatsapp.net',
    });
    const chats: Conversation[] = [];
    const save = async (phone: string, extra: Partial<Conversation>, at: string) => {
      const chat = {
        ...createConversation(company.id, phone, 'whatsapp', at),
        ...extra,
        version: 1,
        messages: [
          { id: randomUUID(), role: 'customer' as const, text: `hello from ${at}`, createdAt: at },
        ],
      };
      expect(await repo.saveConversation(chat, 0)).toBe(true);
      chats.push(chat);
    };
    await save('923001234567', {}, minutesAgo(30));
    // The linked phone, then the same phone paired again: one chat per connection generation.
    await save('+923001234567', { whatsappAddress: address(1) }, minutesAgo(20));
    await save('+923001234567', { whatsappAddress: address(2) }, minutesAgo(10));
    const someoneElse = createConversation(company.id, '+923007654321', 'whatsapp', minutesAgo(5));
    await repo.saveConversation({ ...someoneElse, version: 1 }, 0);

    const response = await app.request(
      `/privacy/customer?phone=${encodeURIComponent('0300 1234567')}`,
    );
    expect(response.status).toBe(200);
    const exported = (await response.json()) as { conversations: Conversation[] };
    expect(exported.conversations.map((c) => c.id).sort()).toEqual(chats.map((c) => c.id).sort());
    for (const chat of exported.conversations)
      expect(chat.messages.map((m) => m.text)).toEqual(
        chats.find((c) => c.id === chat.id)!.messages.map((m) => m.text),
      );
    // The same chats erasing removes.
    const records = await repo.customerRecords(company.id, '923001234567');
    expect(records.conversations.map((c) => c.id).sort()).toEqual(chats.map((c) => c.id).sort());
    expect((await repo.customerRecords(company.id, '   ')).conversations).toEqual([]);
  });

  it('includes the orders placed in those chats', async () => {
    const { order } = await placedOrder(app.repo(), '+923001234567');
    expect(
      (await app.repo().customerRecords(company.id, '923001234567')).orders.map((o) => o.id),
    ).toEqual([order.id]);
    const response = await app.request(
      `/privacy/customer?phone=${encodeURIComponent('+92 300 1234567')}`,
    );
    expect((await response.json()).orders.map((o: Order) => o.id)).toEqual([order.id]);
  });
});

describe('the hosted store’s export call', () => {
  const hosted = () => new SupabaseRepository('https://x.supabase.co', 'k');

  it('asks the database for every matching chat and its orders', async () => {
    const records = { conversations: [{ id: 'c1' }], orders: [{ id: 'o1' }] };
    client.rpc.mockResolvedValue({ data: records, error: null });
    expect(await hosted().customerRecords('company-a', '923001234567')).toEqual(records);
    expect(client.rpc).toHaveBeenCalledWith('customer_records', {
      p_company_id: 'company-a',
      p_phone: '923001234567',
    });
  });

  it('refuses until its migration is applied, so an export is never silently partial', async () => {
    client.rpc.mockResolvedValue({
      data: null,
      error: { code: 'PGRST202', message: 'Could not find the function' },
    });
    const error = await hosted()
      .customerRecords('company-a', '1')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PublicError);
    expect(error).toMatchObject({ status: 503 });
    expect((error as Error).message).toContain('202610200001_prelaunch_fixes.sql');
  });
});
