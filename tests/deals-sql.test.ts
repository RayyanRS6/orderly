// Deals in the database (202610210001_deals.sql) on the whole migration chain: the order check
// prices a deal line as the TypeScript quote does, menu items and deals share one id space, and
// product lines are checked exactly as before.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { buildOrder, createConversation } from '../src/domain/engine';
import { quoteCart } from '../src/domain/pricing';
import { buildWebOrder } from '../src/domain/web-order';
import { sellableCatalog } from '../src/shared/deals';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import { makeJob } from '../server/jobs';
import { placeWebOrderArgs } from '../server/storage/supabase';
import type { Cart, Conversation, Deal, Order, OrderLine } from '../src/shared/types';
import type { WebCart, WebOrderClaim, WebOrderOutcome } from '../src/shared/menu';
import { migratedDb } from './helpers/migrated-db';

const company = seedCompanies[0]!;
const other = seedCompanies[1]!;
const products = seedProducts.filter((p) => p.companyId === company.id);
const now = () => new Date().toISOString();
const DENIED = /permission denied for (function|table)/;
let t: Awaited<ReturnType<typeof migratedDb>>;
const scalar = <T = unknown>(text: string, args: unknown[] = []) => t.scalar<T>(text, args);
const rpc = <T = unknown>(name: string, args: unknown[] = []) => t.rpc<T>(name, args);
let phones = 0;
const nextPhone = () => `+9230055${String(++phones).padStart(5, '0')}`;
beforeAll(async () => {
  t = await migratedDb();
}, 30000);
beforeEach(async () => {
  await t.reset();
  await t.db.exec("set timezone to 'UTC'");
});
afterAll(() => t.db.close());

// Two choice groups that share an option name: picks are matched by the group's position.
const combo = (fields: Partial<Deal> = {}): Deal => ({
  id: randomUUID(),
  companyId: company.id,
  name: 'Zinger Combo',
  description: 'Lunch favourite',
  emoji: '🎁',
  aliases: ['zinger meal'],
  price: 79900,
  regularPrice: 104900,
  items: [
    { name: 'Zinger burger', quantity: 1, productId: products[0]!.id },
    { name: 'Drink', quantity: 1 },
  ],
  choices: [
    {
      id: 'drink',
      name: 'Drink',
      options: [
        { id: 'drink-coke', name: 'Coke', price: 0 },
        { id: 'drink-fanta', name: 'Fanta', price: 5000 },
      ],
    },
    {
      id: 'side',
      name: 'Side',
      options: [
        { id: 'side-fries', name: 'Fries', price: 0 },
        { id: 'side-coke', name: 'Coke', price: 2000 },
      ],
    },
  ],
  available: true,
  position: 1,
  updatedAt: now(),
  ...fields,
});
const saveDeal = (deal: Deal) =>
  t.db.query('insert into deals(id,company_id,data) values($1,$2,$3)', [
    deal.id,
    deal.companyId,
    deal,
  ]);

// A confirmed chat order for these cart items, priced by the real quote at this moment.
function chatOrder(deals: Deal[], items: Cart['items']) {
  const catalog = sellableCatalog(company, products, deals, now());
  const cart: Cart = {
    items,
    fulfillment: 'pickup',
    customerName: 'Ali',
    revision: 0,
    status: 'building',
  };
  const quote = quoteCart(company, catalog, cart);
  const conversation: Conversation = {
    ...createConversation(company.id, nextPhone(), 'whatsapp', now()),
    version: 1,
  };
  const order = buildOrder(company, conversation, cart, quote, now(), `deal:${randomUUID()}`);
  conversation.cart = { ...cart, status: 'submitted', orderId: order.id };
  return { conversation, order };
}
const dealItem = (deal: Deal, modifierIds: string[], quantity = 2) => ({
  productId: deal.id,
  quantity,
  modifierIds,
  notes: '',
});
const commit = (turn: { conversation: Conversation; order: Order }) =>
  rpc('commit_turn', [company.id, turn.conversation, 0, turn.order, [], null]);
// The same order with its first line changed.
function tampered(turn: { conversation: Conversation; order: Order }, line: Partial<OrderLine>) {
  const first = { ...turn.order.items[0]!, ...line };
  first.total = first.unitPrice * first.quantity;
  const order = { ...turn.order, items: [first], subtotal: first.total, total: first.total };
  return { ...turn, order };
}
const count = (table: string) => scalar<number>(`select count(*)::int as value from ${table}`);

describe('a deal order line in the order check', () => {
  it('is placed from a chat as quoted: deal price plus each pick, same option name in two groups', async () => {
    const deal = combo();
    await saveDeal(deal);
    const turn = chatOrder([deal], [dealItem(deal, ['side-coke', 'drink-fanta'])]);
    expect(turn.order.items[0]).toMatchObject({
      unitPrice: 79900 + 5000 + 2000,
      variant: 'Drink: Fanta, Side: Coke',
      modifiers: [],
      choices: [
        { group: 'Drink', option: 'Fanta' },
        { group: 'Side', option: 'Coke' },
      ],
    });
    expect(await commit(turn)).toBe(true);
    const same = chatOrder([deal], [dealItem(deal, ['drink-coke', 'side-coke'], 1)]);
    expect(same.order.items[0]).toMatchObject({
      unitPrice: 81900,
      variant: 'Drink: Coke, Side: Coke',
    });
    expect(await commit(same)).toBe(true);
    expect(await count('orders')).toBe(2);
    const stored = await scalar<Order>('select data as value from orders where id=$1', [
      turn.order.id,
    ]);
    expect(stored.items[0]!.includes).toEqual(['1 × Zinger burger', '1 × Drink']);
  });

  it('accepts a deal with no choices only without a variant, next to a menu item', async () => {
    const deal = combo({ choices: [] });
    await saveDeal(deal);
    const turn = chatOrder(
      [deal],
      [
        dealItem(deal, [], 1),
        { productId: products[0]!.id, quantity: 1, modifierIds: [], notes: '' },
      ],
    );
    expect(turn.order.items[0]).toMatchObject({ choices: [], unitPrice: 79900 });
    expect(turn.order.items[0]).not.toHaveProperty('variant');
    await expect(commit(tampered(turn, { variant: 'Drink: Coke' }))).rejects.toThrow(
      'Catalog changed: invalid deal line',
    );
    expect(await commit(turn)).toBe(true);
  });

  it('refuses a paused deal, one without a numeric price, and another business’s deal', async () => {
    const deal = combo();
    await saveDeal(deal);
    const turn = chatOrder([deal], [dealItem(deal, ['drink-coke', 'side-fries'])]);
    await t.db.query(`update deals set data=jsonb_set(data,'{available}','false') where id=$1`, [
      deal.id,
    ]);
    await expect(commit(turn)).rejects.toThrow('Catalog changed: item unavailable');
    await t.db.query(
      `update deals set data=jsonb_set(data,'{available}','true')||'{"price":"79900"}' where id=$1`,
      [deal.id],
    );
    await expect(commit(turn)).rejects.toThrow('Catalog changed: item unavailable');
    await t.db.query(`update deals set data=data-'price' where id=$1`, [deal.id]);
    await expect(commit(turn)).rejects.toThrow('Catalog changed: item unavailable');
    // The same deal saved by another business: the lookup is the business's own deals only.
    const theirs = combo({ companyId: other.id });
    await saveDeal(theirs);
    const borrowed = chatOrder(
      [{ ...theirs, companyId: company.id }],
      [dealItem(theirs, ['drink-coke', 'side-fries'])],
    );
    await expect(commit(borrowed)).rejects.toThrow('Catalog changed: item unavailable');
    expect(await count('orders')).toBe(0);
    expect(await count('conversations')).toBe(0);
  });

  it('refuses a changed price, missing, swapped or unknown picks, a wrong label and extras', async () => {
    const deal = combo();
    await saveDeal(deal);
    const turn = chatOrder([deal], [dealItem(deal, ['drink-fanta', 'side-fries'])]);
    const refused = async (line: Partial<OrderLine>, message: string) =>
      expect(commit(tampered(turn, line)), JSON.stringify(line)).rejects.toThrow(message);
    await refused({ unitPrice: 79900 }, 'Catalog price changed: review again');
    await refused(
      { choices: [{ group: 'Drink', option: 'Fanta' }], variant: 'Drink: Fanta' },
      'Catalog changed: invalid deal choice',
    );
    await refused(
      {
        choices: [
          { group: 'Side', option: 'Fries' },
          { group: 'Drink', option: 'Fanta' },
        ],
        variant: 'Side: Fries, Drink: Fanta',
      },
      'Catalog changed: invalid deal choice',
    );
    await refused(
      {
        choices: [
          { group: 'Drink', option: 'Pepsi' },
          { group: 'Side', option: 'Fries' },
        ],
        variant: 'Drink: Pepsi, Side: Fries',
      },
      'Catalog changed: invalid deal choice',
    );
    await refused({ choices: undefined }, 'Catalog changed: invalid deal choice');
    await refused({ variant: 'Drink: Fanta' }, 'Catalog changed: invalid deal line');
    await refused({ variant: undefined }, 'Catalog changed: invalid deal line');
    await refused({ modifiers: ['Fanta'] }, 'Catalog changed: invalid deal line');
    await refused({ quantity: 51 }, 'Invalid quantity');
    // An option without a numeric price can never be priced.
    await t.db.query(
      `update deals set data=jsonb_set(data,'{choices,0,options,1,price}','null') where id=$1`,
      [deal.id],
    );
    await expect(commit(turn)).rejects.toThrow('Catalog changed: invalid deal choice');
    await t.db.query(
      `update deals set data=jsonb_set(data,'{choices,0,options,1,price}','6000') where id=$1`,
      [deal.id],
    );
    await expect(commit(turn)).rejects.toThrow('Catalog price changed: review again');
    expect(await count('orders')).toBe(0);
  });

  it('is placed from the menu page the same way, and refused there when the deal changed', async () => {
    const deal = combo();
    await saveDeal(deal);
    const chat: Conversation = {
      ...createConversation(company.id, '+923001112222', 'whatsapp', now()),
      version: 1,
    };
    expect(await rpc('save_conversation', [chat, 0])).toBe(true);
    const cart: WebCart = {
      items: [
        { productId: deal.id, quantity: 1, modifierIds: ['side-fries', 'drink-coke'], notes: '' },
      ],
      fulfillment: 'pickup',
      customerName: 'Ali',
    };
    const catalog = sellableCatalog(company, products, [deal], now(), {
      keepIds: [deal.id],
    });
    const built = buildWebOrder(company, catalog, chat, cart, {
      now: now(),
      submissionKey: `${company.id}:${chat.id}:menu-link:deal`,
    });
    const claim = (n: number): WebOrderClaim => ({
      kind: 'link',
      nonce: `nonce-${String(n).padStart(5, '0')}`,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      keys: ['pn:923001112222'],
    });
    const place = (n: number) => {
      const args = placeWebOrderArgs(
        company.id,
        built.conversation,
        1,
        built.order,
        [
          makeJob(company.id, 'whatsapp_send', {
            conversationId: chat.id,
            messageId: built.replyId,
            text: built.reply,
            source: 'notice',
          }),
        ],
        claim(n),
      );
      const keys = Object.keys(args);
      return scalar<WebOrderOutcome>(
        `select public.place_web_order(${keys.map((k, i) => `${k} => $${i + 1}`).join(',')}) as value`,
        Object.values(args),
      );
    };
    await t.db.query(`update deals set data=jsonb_set(data,'{price}','69900') where id=$1`, [
      deal.id,
    ]);
    await expect(place(1)).rejects.toThrow('Catalog price changed');
    expect(await count('menu_link_uses')).toBe(0);
    await t.db.query(`update deals set data=jsonb_set(data,'{price}','79900') where id=$1`, [
      deal.id,
    ]);
    expect(await place(2)).toMatchObject({ ok: true, order: { id: built.order.id } });
    expect(built.order.items[0]).toMatchObject({
      variant: 'Drink: Coke, Side: Fries',
      total: 79900,
    });
  });

  it('checks a menu item line word for word as 202609160001_launch_hardening.sql did', async () => {
    const lines = (text: string) => text.replace(/\r/g, '').split('\n');
    const hardening = lines(
      readFileSync('supabase/migrations/202609160001_launch_hardening.sql', 'utf8'),
    );
    const start = hardening.findIndex((l) =>
      l.startsWith('create or replace function public.validate_order_snapshot()'),
    );
    const end = hardening.indexOf('end $$;', start);
    // Every line but the header and the variables, in the same order.
    const kept = hardening.slice(start + 2, end + 1);
    const deals = lines(readFileSync('supabase/migrations/202610210001_deals.sql', 'utf8'));
    let at = deals.findIndex((l) =>
      l.startsWith('create or replace function public.validate_order_snapshot()'),
    );
    expect(deals[at]).toBe(hardening[start]);
    for (const line of kept) {
      at = deals.indexOf(line, at + 1);
      expect(at, line).toBeGreaterThan(0);
    }
    // And a menu item order is still refused as before.
    const turn = chatOrder(
      [],
      [{ productId: products[0]!.id, quantity: 1, modifierIds: [], notes: '' }],
    );
    await expect(commit(tampered(turn, { variant: 'Large' }))).rejects.toThrow('Invalid variant');
    await expect(commit(tampered(turn, { unitPrice: 1 }))).rejects.toThrow(
      'Catalog price changed: review again',
    );
    expect(await commit(turn)).toBe(true);
  });
});

describe('one id space for menu items and deals', () => {
  it('refuses a menu item with any business’s deal id, by import or one by one', async () => {
    const own = combo();
    const theirs = combo({ companyId: other.id });
    await saveDeal(own);
    await saveDeal(theirs);
    const product = (id: string) => ({ ...products[0]!, id, companyId: company.id });
    for (const id of [own.id, theirs.id]) {
      await expect(rpc('replace_products', [company.id, [product(id)]])).rejects.toThrow(
        'Menu item ID is already in use',
      );
      await expect(
        t.db.query('insert into products(id,company_id,data) values($1,$2,$3)', [
          id,
          company.id,
          product(id),
        ]),
      ).rejects.toThrow('Menu item ID is already in use');
    }
    await expect(
      t.db.query(
        `update products set id=$1, data=jsonb_set(data,'{id}',to_jsonb($1::text)) where id=$2`,
        [own.id, products[0]!.id],
      ),
    ).rejects.toThrow('Menu item ID is already in use');
    // The menu is as it was, and the other business still sells its deal.
    expect(await count(`products where company_id='${company.id}'`)).toBe(products.length);
    const fresh = chatOrder([own], [dealItem(own, ['drink-coke', 'side-fries'])]);
    expect(await commit(fresh)).toBe(true);
  });

  it('refuses a deal with a menu item’s id, and moving a deal to another business', async () => {
    await expect(saveDeal(combo({ id: products[0]!.id }))).rejects.toThrow(
      'Menu item ID is already in use',
    );
    await expect(
      saveDeal(combo({ id: seedProducts.find((p) => p.companyId === other.id)!.id })),
    ).rejects.toThrow('Menu item ID is already in use');
    const deal = combo();
    await saveDeal(deal);
    await expect(
      t.db.query(
        `update deals set id=$1, data=jsonb_set(data,'{id}',to_jsonb($1::text)) where id=$2`,
        [products[1]!.id, deal.id],
      ),
    ).rejects.toThrow('Menu item ID is already in use');
    await expect(
      t.db.query(
        `update deals set company_id=$1, data=jsonb_set(data,'{companyId}',to_jsonb($1::text)) where id=$2`,
        [other.id, deal.id],
      ),
    ).rejects.toThrow('Cross-company reassignment is forbidden');
    await expect(
      t.db.query('insert into deals(id,company_id,data) values($1,$2,$3)', [
        randomUUID(),
        company.id,
        combo(),
      ]),
    ).rejects.toThrow(/check constraint/);
    // An update that keeps the id is fine.
    await t.db.query(`update deals set data=jsonb_set(data,'{price}','70000') where id=$1`, [
      deal.id,
    ]);
    expect(
      await scalar('select (data->>$2)::int as value from deals where id=$1', [deal.id, 'price']),
    ).toBe(70000);
  });
});

describe('the deals table', () => {
  it('goes with its business, and a reset leaves none', async () => {
    await saveDeal(combo());
    await saveDeal(combo({ companyId: other.id }));
    await t.db.query('delete from companies where id=$1', [other.id]);
    expect(await count('deals')).toBe(1);
    await t.reset();
    expect(await count('deals')).toBe(0);
  });

  it.each(['anon', 'authenticated'])('is for the server only, never %s', async (role) => {
    await saveDeal(combo());
    for (const signature of ['public.enforce_catalog_id()', 'public.validate_order_snapshot()'])
      expect(
        await scalar(`select has_function_privilege($1,$2,'EXECUTE') as value`, [role, signature]),
        signature,
      ).toBe(false);
    await t.db.exec(`set role ${role}`);
    try {
      await expect(t.db.query('select * from public.deals')).rejects.toThrow(DENIED);
    } finally {
      await t.db.exec('reset role');
    }
    await t.db.exec('set role service_role');
    try {
      expect(await count('deals')).toBe(1);
    } finally {
      await t.db.exec('reset role');
    }
  });
});
