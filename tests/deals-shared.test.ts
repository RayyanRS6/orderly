import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  dealIncludes,
  dealProduct,
  dealSavings,
  dealState,
  dealWhen,
  sellableCatalog,
} from '../src/shared/deals';
// The Deals tab's own helpers, kept out of the menu page's chunk.
import { dealsWorkItOut, openingOverlap } from '../src/shared/deal-insights';
import { dealOpenAt, localClock } from '../src/shared/hours';
import { sortMenuCategories } from '../src/shared/menu';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import type { Deal, DealSchedule, Product } from '../src/shared/types';

const company = seedCompanies[0]!;
const products = seedProducts.filter((p) => p.companyId === company.id);
const biryani = products.find((p) => p.name === 'Chicken Biryani')!;
const karahi = products.find((p) => p.name === 'Chicken Karahi')!;
const daal = products.find((p) => p.name === 'Daal Makhani')!;
const everyDay = [0, 1, 2, 3, 4, 5, 6];
const lunch: DealSchedule = { days: [1, 2, 3, 4, 5], start: '12:00', end: '15:00' };
// A Karachi wall-clock time ('2026-08-14T13:00') as the instant it is.
const pkt = (local: string) => new Date(`${local}:00+05:00`).toISOString();
const at = (local: string) => localClock(company.timezone, pkt(local));
const friday = pkt('2026-08-14T13:00');
const deal = (over: Partial<Deal> = {}): Deal => ({
  id: 'aaaaaaaa-0000-4000-a000-000000000001',
  companyId: company.id,
  name: 'Deal 1',
  description: 'Biryani, half karahi and a drink.',
  emoji: '🎁',
  aliases: ['family deal'],
  price: 79900,
  regularPrice: 104900,
  items: [
    { name: 'Chicken Biryani', quantity: 1, productId: biryani.id },
    {
      name: 'Chicken Karahi (Half)',
      quantity: 1,
      productId: karahi.id,
      variantId: karahi.variants[0]!.id,
    },
    { name: 'Drink', quantity: 1 },
  ],
  choices: [
    {
      id: 'g-drink',
      name: 'Drink',
      options: [
        { id: 'o-coke', name: 'Coke', price: 0 },
        { id: 'o-lassi', name: 'Mango Lassi', price: 5000 },
      ],
    },
  ],
  available: true,
  position: 1,
  updatedAt: '2026-08-01T00:00:00.000Z',
  ...over,
});

afterEach(() => vi.restoreAllMocks());

describe('deal state', () => {
  it('goes paused, then ended, then later, then sold out, then on', () => {
    const ended = { ...lunch, endDate: '2026-08-01' };
    const offItem = { name: 'Daal Makhani', quantity: 1, productId: daal.id };
    const clock = at('2026-08-14T13:00');
    expect(dealState(deal(), products, clock)).toBe('on');
    expect(dealState(deal({ available: false, schedule: ended }), products, clock)).toBe('paused');
    expect(dealState(deal({ schedule: ended, items: [offItem] }), products, clock)).toBe('ended');
    // Outside its times a deal reads "later", even while one of its items is off.
    const outside = at('2026-08-14T16:00');
    expect(dealState(deal({ schedule: lunch, items: [offItem] }), products, outside)).toBe('later');
    expect(dealState(deal({ schedule: lunch, items: [offItem] }), products, clock)).toBe(
      'sold_out',
    );
    expect(dealState(deal({ schedule: lunch }), products, clock)).toBe('on');
  });

  it('ignores items that are no longer linked to the menu', () => {
    const clock = at('2026-08-14T13:00');
    const gone = { name: 'Zinger burger', quantity: 1, productId: 'removed-item' };
    expect(dealState(deal({ items: [gone] }), products, clock)).toBe('on');
    // A size that no longer exists counts as unlinked, not sold out.
    const oldSize = { name: 'Daal (large)', quantity: 1, productId: daal.id, variantId: 'gone' };
    expect(dealState(deal({ items: [oldSize] }), products, clock)).toBe('on');
  });

  it('is later, never on, without a clock when it has times', () => {
    expect(dealState(deal({ schedule: lunch }), products, undefined)).toBe('later');
    expect(dealState(deal(), products, undefined)).toBe('on');
  });
});

describe('deal times in words', () => {
  const allDays = (schedule: DealSchedule, clock = at('2026-08-14T13:00')) =>
    (['en', 'ur', 'roman-ur'] as const).map((lang) => dealWhen(schedule, lang, clock));

  it('says nothing without a schedule', () => {
    expect(dealWhen(undefined, 'en')).toBe('');
    expect(dealWhen(undefined, 'ur', at('2026-08-14T13:00'))).toBe('');
  });

  it('names days, every day and all day in three languages', () => {
    expect(allDays(lunch)).toEqual([
      'Mon–Fri 12:00–15:00',
      'پیر تا جمعہ 12:00–15:00',
      'Monday–Friday 12:00–15:00',
    ]);
    expect(allDays({ days: everyDay, start: '23:00', end: '02:00' })).toEqual([
      'Every day 23:00–02:00',
      'روزانہ 23:00–02:00',
      'rozana 23:00–02:00',
    ]);
    expect(allDays({ days: [0, 6], start: '00:00', end: '00:00' })).toEqual([
      'All day Sat–Sun',
      'ہفتہ تا اتوار سارا دن',
      'Saturday–Sunday poora din',
    ]);
    expect(dealWhen({ days: [1, 3, 5], start: '18:00', end: '20:00' }, 'en')).toBe(
      'Mon, Wed, Fri 18:00–20:00',
    );
    expect(dealWhen({ days: [6, 5, 3, 2, 1], start: '18:00', end: '20:00' }, 'en')).toBe(
      'Mon–Wed, Fri–Sat 18:00–20:00',
    );
    expect(dealWhen({ days: [1, 0], start: '18:00', end: '20:00' }, 'ur')).toBe(
      'اتوار تا پیر 18:00–20:00',
    );
  });

  it('names a night window by the evening it starts', () => {
    // Stored on Saturday (the calendar day of 00:00–03:00): that is Friday night.
    expect(allDays({ days: [6], start: '00:00', end: '03:00' })).toEqual([
      'Fri night 00:00–03:00',
      'جمعہ کی رات 00:00–03:00',
      'Friday raat 00:00–03:00',
    ]);
    expect(allDays({ days: everyDay, start: '00:00', end: '03:00' })).toEqual([
      'Every night 00:00–03:00',
      'ہر رات 00:00–03:00',
      'har raat 00:00–03:00',
    ]);
    expect(dealWhen({ days: [5, 6, 0], start: '00:00', end: '02:00' }, 'en')).toBe(
      'Thu–Sat night 00:00–02:00',
    );
  });

  it('adds "from" until the deal starts and "until" whenever it has an end date', () => {
    const dated = { ...lunch, startDate: '2026-03-02', endDate: '2026-08-14' };
    expect(allDays(dated, at('2026-02-23T13:00'))).toEqual([
      'Mon–Fri 12:00–15:00 · from 2 Mar · until 14 Aug',
      'پیر تا جمعہ 12:00–15:00 · 2 مارچ سے · 14 اگست تک',
      'Monday–Friday 12:00–15:00 · 2 Mar se · 14 Aug tak',
    ]);
    expect(allDays(dated, at('2026-03-02T09:00'))).toEqual([
      'Mon–Fri 12:00–15:00 · until 14 Aug',
      'پیر تا جمعہ 12:00–15:00 · 14 اگست تک',
      'Monday–Friday 12:00–15:00 · 14 Aug tak',
    ]);
    // The year shows when it isn't this year, and always without a clock.
    const newYear = { ...lunch, startDate: '2027-01-01', endDate: '2027-01-05' };
    expect(dealWhen(newYear, 'en', at('2026-12-20T13:00'))).toBe(
      'Mon–Fri 12:00–15:00 · from 1 Jan 2027 · until 5 Jan 2027',
    );
    expect(dealWhen(dated, 'en')).toBe('Mon–Fri 12:00–15:00 · from 2 Mar 2026 · until 14 Aug 2026');
    const independence = { days: everyDay, start: '00:00', end: '00:00', endDate: '2026-08-14' };
    expect(dealWhen(independence, 'en', at('2026-08-14T13:00'))).toBe('All day · until 14 Aug');
  });

  it('keeps "from" after midnight on the start date while a night is still the evening before', () => {
    // 01:00 on 2 Mar is the night of 1 Mar, before the start: refused, so it must not read as
    // "every day 23:00–02:00" at a time inside those hours.
    const late = { days: everyDay, start: '23:00', end: '02:00', startDate: '2026-03-02' };
    expect(dealOpenAt(late, at('2026-03-02T01:00'))).toBe(false);
    expect(allDays(late, at('2026-03-02T01:00'))).toEqual([
      'Every day 23:00–02:00 · from 2 Mar',
      'روزانہ 23:00–02:00 · 2 مارچ سے',
      'rozana 23:00–02:00 · 2 Mar se',
    ]);
    // Later that day the next night is the first one; once it runs, "from" has gone.
    expect(dealWhen(late, 'en', at('2026-03-02T10:00'))).toBe('Every day 23:00–02:00');
    expect(dealOpenAt(late, at('2026-03-02T23:30'))).toBe(true);
    expect(dealWhen(late, 'en', at('2026-03-03T01:00'))).toBe('Every day 23:00–02:00');
    const night = { days: everyDay, start: '00:00', end: '03:00', startDate: '2026-03-02' };
    expect(dealOpenAt(night, at('2026-03-02T01:00'))).toBe(false);
    expect(allDays(night, at('2026-03-02T01:00'))).toEqual([
      'Every night 00:00–03:00 · from 2 Mar',
      'ہر رات 00:00–03:00 · 2 مارچ سے',
      'har raat 00:00–03:00 · 2 Mar se',
    ]);
    expect(dealOpenAt(night, at('2026-03-03T01:00'))).toBe(true);
    expect(dealWhen(night, 'roman-ur', at('2026-03-03T01:00'))).toBe('har raat 00:00–03:00');
    // A Ramadan sehri deal: its first morning is the night of 8 Feb, so 8 Feb 04:00 is before it.
    const sehri = { ...night, start: '03:00', end: '05:30', startDate: '2027-02-08' };
    const sehriDated = { ...sehri, endDate: '2027-03-09' };
    expect(dealWhen(sehriDated, 'en', at('2027-02-08T04:00'))).toBe(
      'Every night 03:00–05:30 · from 8 Feb · until 9 Mar',
    );
    expect(dealWhen(sehriDated, 'en', at('2027-02-09T04:00'))).toBe(
      'Every night 03:00–05:30 · until 9 Mar',
    );
  });

  it('never reads as on now at a time a dated deal is refused, around its start date', () => {
    const schedules: DealSchedule[] = [
      { days: everyDay, start: '23:00', end: '02:00', startDate: '2026-03-02' },
      { days: everyDay, start: '00:00', end: '03:00', startDate: '2026-03-02' },
      { days: [1], start: '23:00', end: '02:00', startDate: '2026-03-02' },
      { days: [2], start: '00:00', end: '02:00', startDate: '2026-03-02' },
      { ...lunch, startDate: '2026-03-02' },
      { days: everyDay, start: '00:00', end: '00:00', startDate: '2026-03-02' },
    ];
    for (const schedule of schedules)
      for (let half = 0; half < 4 * 48; half++) {
        const instant = new Date(Date.parse(pkt('2026-02-28T00:00')) + half * 30 * 60_000);
        const clock = localClock(company.timezone, instant.toISOString())!;
        const words = dealWhen(schedule, 'en', clock);
        const label = `${JSON.stringify(schedule)} at ${clock.date} ${clock.minute}`;
        // Refused inside its hours: the wording says when it starts. On: it doesn't.
        if (dealOpenAt(schedule, clock)) expect(words, label).not.toContain('from');
        else if (dealOpenAt({ ...schedule, startDate: undefined }, clock))
          expect(words, label).toContain('· from 2 Mar');
      }
  });
});

describe('deals as menu entries', () => {
  it('lists what is included from the stored names', () => {
    expect(dealIncludes(deal())).toEqual([
      '1 × Chicken Biryani',
      '1 × Chicken Karahi (Half)',
      '1 × Drink',
    ]);
  });

  it('builds a product-shaped entry with no empty keys', () => {
    const clock = at('2026-08-14T13:00');
    const entry = dealProduct(deal({ schedule: lunch }), 'on', clock, 'Deals');
    expect(entry).toEqual({
      id: deal().id,
      companyId: company.id,
      name: 'Deal 1',
      description: 'Biryani, half karahi and a drink.',
      emoji: '🎁',
      aliases: ['family deal'],
      category: 'Deals',
      price: 79900,
      available: true,
      variants: [],
      modifiers: [],
      deal: {
        includes: ['1 × Chicken Biryani', '1 × Chicken Karahi (Half)', '1 × Drink'],
        choices: deal().choices,
        regularPrice: 104900,
        state: 'on',
        when: 'Mon–Fri 12:00–15:00',
        schedule: lunch,
      },
    });
    const bare = dealProduct(
      deal({ regularPrice: undefined, imageUrl: 'https://img.example/deal.jpg' }),
      'later',
      clock,
      'deals',
    );
    expect(bare.available).toBe(false);
    expect(bare.imageUrl).toBe('https://img.example/deal.jpg');
    expect(Object.keys(bare.deal!)).toEqual(['includes', 'choices', 'state']);
    expect(Object.values(bare).includes(undefined)).toBe(false);
  });

  it('puts deals first, by position then name with numbers in order', () => {
    const catalog = sellableCatalog(
      company,
      products,
      [
        deal({ id: 'd-10', name: 'Deal 10', position: 2 }),
        deal({ id: 'd-2', name: 'Deal 2', position: 2 }),
        deal({ id: 'd-1', name: 'Deal 1', position: 1 }),
      ],
      friday,
    );
    expect(catalog.map((p) => p.name).slice(0, 4)).toEqual([
      'Deal 1',
      'Deal 2',
      'Deal 10',
      products[0]!.name,
    ]);
    expect(catalog.slice(3)).toEqual(products);
  });

  it('gives back the products alone, as they are, when there are no deals', () => {
    const catalog = sellableCatalog(company, products, [], friday);
    expect(catalog).toEqual(products);
    expect(catalog).not.toBe(products);
    expect(catalog.every((p, i) => p === products[i])).toBe(true);
  });

  it('leaves out paused and ended deals unless the bot asks for all or a cart holds them', () => {
    const paused = deal({ id: 'd-paused', name: 'Paused deal', available: false });
    const ended = deal({
      id: 'd-ended',
      name: 'Old deal',
      schedule: { ...lunch, endDate: '2026-08-01' },
    });
    const later = deal({ id: 'd-later', name: 'Lunch deal', schedule: lunch });
    const soldOut = deal({
      id: 'd-sold',
      name: 'Daal deal',
      items: [{ name: 'Daal', quantity: 1, productId: daal.id }],
    });
    const deals = [paused, ended, later, soldOut];
    const evening = pkt('2026-08-14T19:00');
    const entries = (opts?: Parameters<typeof sellableCatalog>[4]) =>
      sellableCatalog(company, products, deals, evening, opts)
        .filter((p) => p.deal)
        .map((p) => [p.name, p.deal!.state, p.available]);
    // Same position, so by name.
    expect(entries()).toEqual([
      ['Daal deal', 'sold_out', false],
      ['Lunch deal', 'later', false],
    ]);
    expect(entries({ keepIds: ['d-ended'] })).toEqual([
      ['Daal deal', 'sold_out', false],
      ['Lunch deal', 'later', false],
      ['Old deal', 'ended', false],
    ]);
    expect(entries({ all: true })).toEqual([
      ['Daal deal', 'sold_out', false],
      ['Lunch deal', 'later', false],
      ['Old deal', 'ended', false],
      ['Paused deal', 'paused', false],
    ]);
    const lunchEntry = sellableCatalog(company, products, deals, evening).find(
      (p) => p.id === 'd-later',
    )!;
    expect(lunchEntry.deal!.when).toBe('Mon–Fri 12:00–15:00');
  });

  it('joins a legacy "deals" category so the menu shows one deal section', () => {
    const legacy: Product = {
      ...biryani,
      id: 'legacy-family-deal',
      name: 'Family Deal',
      category: 'deals ',
    };
    const catalog = sellableCatalog(company, [...products, legacy], [deal()], friday);
    expect(catalog[0]!.category).toBe('deals ');
    const sections = sortMenuCategories(catalog);
    expect(sections.filter((s) => /^deals?$/i.test(s.name.trim()))).toHaveLength(1);
    expect(sections[0]!.items.map((p) => p.name)).toEqual(['Deal 1', 'Family Deal']);
    expect(sellableCatalog(company, products, [deal()], friday)[0]!.category).toBe('Deals');
  });

  it("drops a deal that shares a product's id, and another business's deals", () => {
    const clash = deal({ id: biryani.id, name: 'Clash deal' });
    const other = deal({ id: 'd-other', companyId: seedCompanies[1]!.id, name: 'Other deal' });
    const catalog = sellableCatalog(company, products, [clash, other, deal()], friday, {
      all: true,
      keepIds: [biryani.id, 'd-other'],
    });
    expect(catalog.filter((p) => p.deal).map((p) => p.name)).toEqual(['Deal 1']);
    expect(catalog.filter((p) => p.id === biryani.id)).toEqual([biryani]);
  });

  it('reads the clock once for all deals, and fails closed without one', () => {
    const read = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
    const deals = [1, 2, 3].map((n) => deal({ id: `d-${n}`, name: `Deal ${n}`, schedule: lunch }));
    sellableCatalog(company, products, deals, friday);
    expect(read).toHaveBeenCalledTimes(1);
    const lost = { ...company, timezone: 'Invalid/Zone' };
    const catalog = sellableCatalog(lost, products, [deals[0]!, deal({ id: 'd-any' })], friday);
    expect(catalog.filter((p) => p.deal).map((p) => [p.id, p.deal!.state])).toEqual([
      ['d-1', 'later'],
      ['d-any', 'on'],
    ]);
  });
});

describe('savings and working out the regular price', () => {
  it('shows a saving only when the regular price is higher', () => {
    expect(dealSavings(deal())).toBe(25000);
    expect(dealSavings(deal({ regularPrice: 79900 }))).toBeUndefined();
    expect(dealSavings(deal({ regularPrice: 50000 }))).toBeUndefined();
    expect(dealSavings(deal({ regularPrice: undefined }))).toBeUndefined();
    // The same from a menu entry, where the regular price sits in its deal block.
    expect(dealSavings(dealProduct(deal(), 'on', undefined, 'Deals'))).toBe(25000);
    expect(dealSavings(biryani)).toBeUndefined();
  });

  it('adds up linked items and names the ones it cannot price', () => {
    const work = dealsWorkItOut(
      {
        items: [
          { name: 'Chicken Biryani', quantity: 2, productId: biryani.id },
          {
            name: 'Chicken Karahi (Full)',
            quantity: 1,
            productId: karahi.id,
            variantId: karahi.variants[1]!.id,
          },
          { name: 'Chicken Karahi', quantity: 1, productId: karahi.id },
          { name: 'Drink', quantity: 1 },
          { name: 'Zinger burger', quantity: 1, productId: 'removed-item' },
        ],
      },
      products,
    );
    expect(work).toEqual({
      total: 2 * 45000 + 220000,
      notCounted: ['Chicken Karahi (no size)', 'Drink (not linked)', 'Zinger burger (not linked)'],
    });
  });
});

describe('deal times against opening hours', () => {
  const open = (start: string, end: string, days = everyDay) => ({ start, end, days });

  it('finds no problem when the restaurant is open for the whole deal', () => {
    expect(openingOverlap(lunch, open('00:00', '00:00'))).toEqual({
      dealMinutes: 5 * 180,
      overlapMinutes: 5 * 180,
      closedParts: [],
    });
  });

  it('names the night a late deal falls on a closed day', () => {
    // Open Mon–Sat 12:00–02:00 (closed Sunday), deal Mon–Sat 00:00–02:00: Monday 00:00–02:00 is
    // Sunday night, when the restaurant is shut.
    const result = openingOverlap(
      { days: [1, 2, 3, 4, 5, 6], start: '00:00', end: '02:00' },
      open('12:00', '02:00', [1, 2, 3, 4, 5, 6]),
    );
    expect(result).toEqual({
      dealMinutes: 6 * 120,
      overlapMinutes: 5 * 120,
      closedParts: ['Sun night 00:00–02:00'],
    });
  });

  it('says when a deal is never on while the restaurant is open', () => {
    expect(
      openingOverlap({ days: everyDay, start: '00:00', end: '03:00' }, open('12:00', '23:00')),
    ).toEqual({
      dealMinutes: 7 * 180,
      overlapMinutes: 0,
      closedParts: ['Every night 00:00–03:00'],
    });
  });

  it('joins the same closed times on several days', () => {
    expect(
      openingOverlap({ days: everyDay, start: '22:00', end: '02:00' }, open('12:00', '23:00'))
        .closedParts,
    ).toEqual(['Every day 23:00–02:00']);
    const lateDeal = { days: [1, 2, 3, 4, 5], start: '22:00', end: '23:30' };
    const hours = { days: [1, 2, 3, 4], start: '12:00', end: '23:00' };
    // Friday is closed all day, so the whole Friday window is a closed part too.
    expect(openingOverlap(lateDeal, hours).closedParts).toEqual([
      'Mon–Thu 23:00–23:30',
      'Fri 22:00–23:30',
    ]);
    expect(
      openingOverlap(
        { days: [0, 6], start: '00:00', end: '00:00' },
        open('00:00', '00:00', [1, 2, 3, 4, 5, 6]),
      ).closedParts,
    ).toEqual(['All day Sun']);
  });
});
