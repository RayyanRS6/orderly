// Deals on the menu page itself: the deal card, the pick-one-per-group picker, checkout lines,
// the minute-by-minute menu refresh and the order code screen. The tests run without a browser,
// so they check what the page renders on the server and the helpers behind it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ItemCard, MenuPage } from '../src/components/MenuPage';
import {
  dealPicked,
  dealPicks,
  hasTimedDeal,
  loadDraft,
  notOrderable,
  saveCart,
  saveDraft,
  type DraftCode,
} from '../src/lib/menu-cart';
import type { PublicMenu, PublicMenuDeal, PublicMenuItem } from '../src/shared/menu';

afterEach(() => {
  vi.unstubAllGlobals();
});

const offer: PublicMenuDeal = {
  includes: ['1 × Zinger burger', '1 × Fries', '1 × Drink'],
  choices: [
    {
      id: 'drink',
      name: 'Drink',
      options: [
        { id: 'coke', name: 'Coke', price: 0 },
        { id: 'fanta', name: 'Fanta', price: 5000 },
      ],
    },
    {
      id: 'side',
      name: 'Side',
      options: [
        { id: 'fries', name: 'Fries', price: 0 },
        { id: 'raita', name: 'Raita', price: 3000 },
      ],
    },
  ],
  regularPrice: 104900,
  state: 'on',
  when: 'Mon–Fri 12:00–15:00',
};
const combo: PublicMenuItem = {
  id: 'deal-1',
  name: 'Zinger Deal',
  description: 'Lunch for one',
  price: 79900,
  available: true,
  emoji: '🎁',
  variants: [],
  modifiers: [],
  deal: offer,
};
const card = (item: PublicMenuItem, picking = false) =>
  renderToStaticMarkup(
    createElement(ItemCard, {
      item,
      ordering: true,
      inCart: 0,
      picking,
      onPick: () => {},
      onAdd: () => {},
    }),
  ).replace(/<!-- -->/g, '');
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const source = () => readFileSync(join(process.cwd(), 'src/components/MenuPage.tsx'), 'utf8');

describe('deal card', () => {
  it('shows the price, the price if bought separately, the saving, what it includes and when', () => {
    const html = card(combo);
    expect(html).toMatch(/Rs\. 799<s [^>]*>Rs\. 1,049<\/s><\/p>/);
    expect(html).toContain('You save Rs. 250');
    expect(html).toContain('Includes: 1 × Zinger burger · 1 × Fries · 1 × Drink');
    expect(text(html)).toContain('Drink: Coke, Fanta +Rs. 50');
    expect(text(html)).toContain('Side: Fries, Raita +Rs. 30');
    expect(html).toContain('Mon–Fri 12:00–15:00');
    expect(html).not.toContain('Sold out');
    // No saving, no strike and no badge.
    for (const regularPrice of [undefined, 79900, 50000]) {
      const plain = card({ ...combo, deal: { ...offer, regularPrice } });
      expect(plain).not.toContain('<s ');
      expect(plain).not.toContain('You save');
    }
  });

  it('says a deal outside its times is not on now, with no Add, and a sold-out one is sold out', () => {
    // Picking is still set from before a fresh menu took the deal off: its picker goes too.
    const later = card({ ...combo, available: false, deal: { ...offer, state: 'later' } }, true);
    expect(later).toContain('Not on now');
    expect(later).toContain('Mon–Fri 12:00–15:00');
    expect(later).not.toContain('Sold out');
    expect(later).not.toContain('<button');
    expect(later).not.toContain('type="radio"');
    const soldOut = card({ ...combo, available: false, deal: { ...offer, state: 'sold_out' } });
    expect(soldOut).toContain('Sold out');
    expect(soldOut).not.toContain('Not on now');
    expect(soldOut).not.toContain('<button');
    // The same for a dish whose options were open when it sold out.
    const dish: PublicMenuItem = {
      ...combo,
      id: 'p1',
      available: false,
      deal: undefined,
      variants: [
        { id: 'v1', name: 'Half', price: 45000 },
        { id: 'v2', name: 'Full', price: 80000 },
      ],
    };
    expect(card(dish, true)).not.toContain('aria-pressed');
  });

  it('adds a deal with nothing to choose in one tap', () => {
    const simple = card({ ...combo, deal: { ...offer, choices: [] } });
    expect(simple).toContain('aria-label="Add Zinger Deal"');
    expect(simple).not.toContain('aria-expanded');
  });
});

describe('deal picker', () => {
  it('asks for every pick with nothing chosen for the customer, and never disables Add', () => {
    const closed = card(combo);
    expect(closed).toContain('aria-label="Choose Zinger Deal"');
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain('type="radio"');

    const html = card(combo, true);
    // Exactly one toggle per card.
    expect(html.match(/aria-expanded=/g)).toHaveLength(1);
    expect(html).toContain('aria-expanded="true"');
    expect(html.match(/<fieldset/g)).toHaveLength(2);
    expect(html).toContain('<legend class="field-label">Drink</legend>');
    expect(html).toContain('<legend class="field-label">Side</legend>');
    expect(html.match(/type="radio"/g)).toHaveLength(4);
    expect(html.match(/name="deal-deal-1-drink"/g)).toHaveLength(2);
    expect(html).not.toContain('checked');
    expect(html).toContain('accent-brand-600');
    expect(html).toContain('max-md:min-h-11');
    // An extra charge shows only where there is one.
    expect([...html.matchAll(/<label[^>]*>([\s\S]*?)<\/label>/g)].map((m) => text(m[1]!))).toEqual([
      'Coke',
      'Fanta +Rs. 50',
      'Fries',
      'Raita +Rs. 30',
    ]);
    const add = /<button type="button" class="btn btn-primary"[^>]*>([\s\S]*?)<\/button>/.exec(
      html,
    )!;
    expect(add[0]).not.toContain('disabled');
    expect(text(add[1]!)).toBe('Choose Drink');
  });

  it('names the next group to pick, then adds with the extra charges in the price', () => {
    expect(dealPicked(offer, 79900, {})).toEqual({ next: 0, unit: 79900, modifierIds: [] });
    expect(dealPicked(offer, 79900, { drink: 'fanta' })).toEqual({
      next: 1,
      unit: 84900,
      modifierIds: ['fanta'],
    });
    expect(dealPicked(offer, 79900, { side: 'raita' })).toMatchObject({ next: 0 });
    expect(dealPicked(offer, 79900, { side: 'raita', drink: 'fanta' })).toEqual({
      next: -1,
      unit: 87900,
      modifierIds: ['fanta', 'raita'],
    });
    // An id from another group is no pick.
    expect(dealPicked(offer, 79900, { drink: 'raita', side: 'fries' }).next).toBe(0);
  });
});

describe('deal lines in checkout', () => {
  it('lists the picks in the deal’s group order and says when a deal is only off for now', () => {
    expect(dealPicks(offer, ['raita', 'coke'])).toEqual(['Drink: Coke', 'Side: Raita']);
    expect(dealPicks(offer, [])).toEqual([]);
    expect(notOrderable({ deal: { ...offer, state: 'later' } })).toBe('Not on now');
    expect(notOrderable({ deal: { ...offer, state: 'sold_out' } })).toBe('Sold out');
    expect(notOrderable({})).toBe('Sold out');
    const page = source();
    expect(page).toContain('dealPicks(item.deal, line.modifierIds)');
    // The card and the checkout line word it the same way.
    expect(page.match(/<Badge>\{notOrderable\(item\)\}<\/Badge>/g)).toHaveLength(2);
  });
});

describe('deals with set times', () => {
  const menu: PublicMenu = {
    slug: 'karachi-bites',
    restaurant: {
      name: 'Karachi Bites',
      address: '',
      phone: '',
      timezone: 'Asia/Karachi',
      openingHours: { start: '12:00', end: '23:00', days: [0, 1, 2, 3, 4, 5, 6] },
      deliveryZones: [],
      fulfillment: 'pickup',
      currency: 'PKR',
    },
    categories: [
      {
        name: 'Deals',
        items: [combo, { ...combo, id: 'deal-2', deal: { ...offer, when: undefined } }],
      },
      { name: 'Rice', items: [{ ...combo, id: 'p1', deal: undefined }] },
    ],
    ordering: { open: true, botOn: true, publicOrdering: true },
    generatedAt: '2026-10-21T07:05:00.000Z',
  };

  it('knows which menus and orders have a deal that runs only at set times', () => {
    expect(hasTimedDeal(menu)).toBe(true);
    expect(hasTimedDeal(menu, ['deal-1'])).toBe(true);
    expect(hasTimedDeal(menu, ['deal-2', 'p1'])).toBe(false);
    expect(hasTimedDeal({ ...menu, categories: [menu.categories[1]!] })).toBe(false);
    expect(hasTimedDeal(undefined)).toBe(false);
  });

  it('reads the menu again every minute while it is on screen, never during checkout', () => {
    const page = source();
    const effect = page.slice(
      page.indexOf('const watchDeals'),
      page.indexOf('}, [slug, watchDeals]);'),
    );
    expect(effect).toContain('hasTimedDeal(menu) && !checkout && !drafted && !placed');
    expect(effect).toContain("document.visibilityState !== 'visible'");
    expect(effect).toContain('window.setInterval(refresh, 60_000)');
    expect(effect).toContain("document.addEventListener('visibilitychange', refresh)");
    expect(effect).toContain("document.removeEventListener('visibilitychange', refresh)");
    // The plain request: the menu's 30-second cache is fine here.
    expect(effect).toContain('api<PublicMenu>(`/public/menu/${slug}`).then(');
    expect(effect).not.toContain('no-store');
    // A hook, so it comes before the page's first early return.
    expect(page.indexOf('const watchDeals')).toBeLessThan(page.indexOf('if (drafted)'));
  });

  it('asks for the code to be sent now when the order has a deal with set times', () => {
    const data = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (name: string) => data.get(name) ?? null,
      setItem: (name: string, value: string) => void data.set(name, String(value)),
      removeItem: (name: string) => void data.delete(name),
    });
    const slug = 'karachi-bites';
    const draft: DraftCode = {
      code: 'OM-ABCD-EFGH',
      expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
      whatsappUrl: 'https://wa.me/923001112222?text=Hi',
    };
    saveCart(slug, [
      { productId: 'deal-1', quantity: 1, modifierIds: ['coke', 'fries'], notes: '' },
    ]);
    const note = 'Send it now: deals only run at their set times.';
    saveDraft(slug, { ...draft, timedDeal: true });
    expect(loadDraft(slug)).toEqual({ ...draft, timedDeal: true });
    expect(renderToStaticMarkup(createElement(MenuPage, { slug }))).toContain(note);
    saveDraft(slug, draft);
    expect(renderToStaticMarkup(createElement(MenuPage, { slug }))).not.toContain(note);
    // Only the page's own mark is kept.
    data.set(`orderly.menu.${slug}.draft`, JSON.stringify({ ...draft, timedDeal: 'yes' }));
    expect(loadDraft(slug)).toEqual(draft);
    // The page marks the code from the deals in the order it sends.
    const page = source();
    const placeOrder = page.slice(
      page.indexOf('async function placeOrder'),
      page.indexOf('if (placed)'),
    );
    expect(placeOrder).toContain('const ids = cart.map((line) => line.productId);');
    expect(placeOrder).toMatch(
      /hasTimedDeal\(menu, ids\)\s*\? \{ \.\.\.created, timedDeal: true \}\s*: created;\s*saveDraft\(slug, draft\);\s*setDrafted\(draft\);/,
    );
  });
});
