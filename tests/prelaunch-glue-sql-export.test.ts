// A customer export finds what erasing removes (F11): customer_records in
// 202610200001_prelaunch_fixes.sql on the whole migration chain.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createConversation, processTurn } from '../src/domain/engine';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import type { BotAction, Conversation, Order } from '../src/shared/types';
import { migratedDb } from './helpers/migrated-db';

const company = seedCompanies[0]!;
const other = seedCompanies[1]!;
const products = seedProducts.filter((p) => p.companyId === company.id);
const now = () => new Date().toISOString();
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60000).toISOString();
const DENIED = /permission denied for function/;
let t: Awaited<ReturnType<typeof migratedDb>>;
const scalar = <T = unknown>(text: string, args: unknown[] = []) => t.scalar<T>(text, args);
const rpc = <T = unknown>(name: string, args: unknown[] = []) => t.rpc<T>(name, args);
async function chat(phone: string, extra: Partial<Conversation> = {}, companyId = company.id) {
  const c = {
    ...createConversation(companyId, phone, 'whatsapp', minutesAgo(60)),
    ...extra,
    version: 1,
  };
  expect(await rpc('save_conversation', [c, 0])).toBe(true);
  return c;
}
beforeAll(async () => {
  t = await migratedDb();
}, 30000);
beforeEach(() => t.reset());
afterAll(() => t.db.close());

describe('a customer export finds what erasing removes (F11)', () => {
  async function placedOrder(phone: string) {
    let c = createConversation(company.id, phone, 'whatsapp', minutesAgo(30));
    const turn = (action: BotAction) => {
      const result = processTurn(company, products, c, {
        messageId: randomUUID(),
        text: action.type === 'confirm' ? 'confirm' : 'test',
        action,
        now: now(),
      });
      c = result.conversation;
      return result;
    };
    turn({ type: 'add_item', productId: products[0]!.id, quantity: 2 });
    turn({ type: 'set_details', customerName: 'Test Customer', fulfillment: 'pickup' });
    turn({ type: 'review' });
    const result = turn({ type: 'confirm' });
    result.conversation.version = 1;
    expect(
      await rpc('commit_turn', [company.id, result.conversation, 0, result.order, [], null]),
    ).toBe(true);
    return { conversation: result.conversation, order: result.order! };
  }
  const address = (generation: number) => ({
    connectionId: '756bc31b-63af-4ce9-8324-1fd87803ae71',
    generation,
    provider: 'baileys' as const,
    peer: '923001234567@s.whatsapp.net',
  });
  const nothing = { conversations: [], orders: [] };

  it('returns every matching chat and its orders, exactly the chats erase_customer deletes', async () => {
    const meta = await placedOrder('923001234567');
    const linked = [
      await chat('+923001234567', { whatsappAddress: address(1) }),
      await chat('+923001234567', { whatsappAddress: address(2) }),
    ];
    // The exact text also matches a test chat, as erasing does.
    const demo = {
      ...createConversation(company.id, '923001234567', 'demo', minutesAgo(5)),
      version: 1,
    };
    expect(await rpc('save_conversation', [demo, 0])).toBe(true);
    await chat('+923007654321');
    await chat('923001234567', {}, other.id);

    const records = await rpc<{ conversations: Conversation[]; orders: Order[] }>(
      'customer_records',
      [company.id, '923001234567'],
    );
    const ids = [meta.conversation.id, ...linked.map((c) => c.id), demo.id];
    expect(records.conversations.map((c) => c.id).sort()).toEqual([...ids].sort());
    expect(records.orders.map((o) => o.id)).toEqual([meta.order.id]);
    // '+digits' finds the same WhatsApp chats; a number with its 0 is not a whole number.
    const plus = await rpc<{ conversations: Conversation[] }>('customer_records', [
      company.id,
      '+923001234567',
    ]);
    expect(plus.conversations).toHaveLength(3);
    expect(await rpc('customer_records', [company.id, '0300 1234567'])).toEqual(nothing);
    expect(await rpc('customer_records', [company.id, '  '])).toEqual(nothing);

    await t.db.query(
      "update companies set data=jsonb_set(data,'{botEnabled}','false') where id=$1",
      [company.id],
    );
    expect(await rpc('erase_customer', [company.id, '923001234567'])).toBe(ids.length);
    expect(await rpc('customer_records', [company.id, '923001234567'])).toEqual(nothing);
  });

  it.each(['anon', 'authenticated'])('is for the server only, never %s', async (role) => {
    const signature = 'public.customer_records(text,text)';
    expect(
      await scalar(`select has_function_privilege($1,$2,'EXECUTE') as value`, [role, signature]),
    ).toBe(false);
    expect(
      await scalar(`select has_function_privilege('service_role',$1,'EXECUTE') as value`, [
        signature,
      ]),
    ).toBe(true);
    await t.db.exec(`set role ${role}`);
    try {
      await expect(rpc('customer_records', [company.id, '923001234567'])).rejects.toThrow(DENIED);
    } finally {
      await t.db.exec('reset role');
    }
  });
});
