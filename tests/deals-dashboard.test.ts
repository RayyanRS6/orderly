// The Deals tab and the other dashboard screens deals reach: the editor's rules (night chips,
// presets, the form made from a saved deal and back), the deals list for owners and staff, Test
// your bot, the order view and Agent flow. No AI is called.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { readFileSync } from 'node:fs';

// Radix draws dialogs into a portal, which server rendering skips: draw an open one in place.
vi.mock('@radix-ui/react-dialog', async () => {
  const { createElement } = await import('react');
  type Props = { children?: ReactNode; className?: string };
  const tag =
    (name: string) =>
    ({ children, className }: Props) =>
      createElement(name, { className }, children);
  return {
    Root: ({ open, children }: Props & { open?: boolean }) => (open ? children : null),
    Portal: ({ children }: Props) => children,
    Overlay: tag('div'),
    Content: tag('div'),
    Close: tag('button'),
    Title: tag('h2'),
    Description: tag('p'),
  };
});
import {
  ALL_DAYS,
  chipsToDays,
  copyChoice,
  dayWords,
  dealBody,
  dealToForm,
  daysToChips,
  detailsProblem,
  formProblem,
  formSchedule,
  formToBody,
  linkedName,
  longWindowNote,
  MAX_CHOICES,
  MAX_OPTIONS,
  menuMatches,
  newDealForm,
  nextDealName,
  openingWarning,
  optionsFromText,
  regularText,
  runsText,
  sameNameWarning,
  scheduleNotice,
  soldOutItem,
  staleRegularPrice,
  timeWords,
  WHEN_PRESETS,
  windowMinutes,
  withDeal,
  withOrder,
  type DealForm,
} from '../src/lib/deal-form';
import { DealEditor, Deals, RELOAD_NOTE } from '../src/components/Deals';
import { AddItem, addText, Playground } from '../src/components/Conversations';
import { Catalog } from '../src/components/Catalog';
import { parseRoute, pages, workspacePath } from '../src/lib/routes';
import { DEAL_LIMITS, dealProduct, dealState, sellableCatalog } from '../src/shared/deals';
import { localClock } from '../src/shared/hours';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import { buildAgentFlow } from '../server/agent-flow';
import { dealSchema } from '../server/validation';
import { MemoryRepository } from '../server/storage/memory';
import type { Deal, Product } from '../src/shared/types';
import { bootstrap, render } from './prelaunch-e-helpers';

const company = seedCompanies[0]!;
const menu = seedProducts.filter((p) => p.companyId === company.id);
const item = (name: string) => menu.find((p) => p.name === name)!;
const biryani = item('Chicken Biryani');
const lassi = item('Mango Lassi');
const karahi = item('Chicken Karahi');
const daal = item('Daal Makhani');
// Wednesday 21 October 2026, 13:00 in Karachi.
const NOW = '2026-10-21T08:00:00.000Z';
const deal = (fields: Partial<Deal> = {}): Deal => ({
  id: 'd-on',
  companyId: company.id,
  name: 'Deal 1',
  description: '',
  emoji: '🎁',
  aliases: [],
  price: 60000,
  regularPrice: 73000,
  items: [
    { name: 'Chicken Biryani', quantity: 1, productId: biryani.id },
    { name: 'Mango Lassi', quantity: 1, productId: lassi.id },
  ],
  choices: [
    {
      id: 'drink',
      name: 'Drink',
      options: [
        { id: 'coke', name: 'Coke', price: 0 },
        { id: 'sprite', name: 'Sprite', price: 5000 },
      ],
    },
  ],
  available: true,
  position: 1,
  updatedAt: '2026-10-20T00:00:00.000Z',
  ...fields,
});
const later = deal({
  id: 'd-later',
  name: 'Evening Deal',
  position: 2,
  regularPrice: undefined,
  schedule: { days: [1, 2, 3, 4, 5], start: '18:00', end: '22:00' },
});
const soldOut = deal({
  id: 'd-sold',
  name: 'Daal Deal',
  position: 3,
  regularPrice: undefined,
  choices: [],
  items: [{ name: 'Daal Makhani', quantity: 1, productId: daal.id }],
});
const paused = deal({ id: 'd-paused', name: 'Paused Deal', position: 4, available: false });
const ended = deal({
  id: 'd-ended',
  name: 'Eid Deal',
  position: 5,
  schedule: {
    days: ALL_DAYS,
    start: '00:00',
    end: '00:00',
    startDate: '2026-09-01',
    endDate: '2026-10-01',
  },
});
const stale = deal({ id: 'd-stale', name: 'Family Deal', position: 6, regularPrice: 104900 });
const broken = deal({
  id: 'd-broken',
  name: 'Zinger Deal',
  position: 7,
  regularPrice: undefined,
  items: [{ name: 'Zinger burger', quantity: 1, productId: 'gone' }],
});
const all = [later, soldOut, paused, ended, stale, broken, deal()];
let ids = 0;
const key = () => `k${++ids}`;

beforeEach(() => {
  ids = 0;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the Deals route', () => {
  it('is a workspace page of its own, next to the menu', () => {
    expect(pages.indexOf('deals')).toBe(pages.indexOf('menu') + 1);
    expect(workspacePath('dastarkhwan', 'deals')).toBe('/app/dastarkhwan/deals');
    expect(parseRoute('/app/dastarkhwan/deals')).toMatchObject({ page: 'deals', valid: true });
    expect(parseRoute('/app/dastarkhwan/deals/extra').valid).toBe(false);
  });

  it('loads the page only when it is opened, and says so if it cannot', () => {
    const app = readFileSync('src/App.tsx', 'utf8');
    expect(app).toMatch(
      /\{ id: 'menu', label: 'Menu', icon: BookOpen \},\s*\{ id: 'deals', label: 'Deals', icon: TicketPercent \}/,
    );
    expect(app).toContain("import('./components/Deals')");
    expect(app).not.toMatch(/import \{ Deals \} from/);
    expect(app).toContain('The Deals page couldn’t load. Reload the page and try again.');
    expect(app).toMatch(/<Suspense fallback=\{[^}]*Loading deals…/);
  });
});

describe('night chips', () => {
  it('stores a night window’s chip as the day after, and reads it back', () => {
    const night = { start: '00:00', end: '03:00' };
    // Friday night and Saturday night run in the small hours of Saturday and Sunday.
    expect(chipsToDays([5, 6], night)).toEqual([0, 6]);
    expect(daysToChips([0, 6], night)).toEqual([5, 6]);
    expect(chipsToDays([6], night)).toEqual([0]);
    // Other windows keep their days as ticked.
    for (const window of [
      { start: '12:00', end: '15:00' },
      { start: '23:00', end: '02:00' },
      { start: '00:00', end: '00:00' },
      { start: '03:00', end: '07:00' },
    ]) {
      expect(chipsToDays([5, 1], window)).toEqual([1, 5]);
      expect(daysToChips([1, 5], window)).toEqual([1, 5]);
    }
  });

  it('keeps the owner’s ticks when the times change, and shifts only on save', () => {
    const form = { ...newDealForm([], key), timed: true, chips: [5], allDay: false };
    const night = { ...form, start: '00:00', end: '03:00' };
    expect(formSchedule(night)).toEqual({ days: [6], start: '00:00', end: '03:00' });
    // Moving the end past 06:00 makes it a daytime window: the same tick, the same day.
    const day = { ...night, end: '07:00' };
    expect(day.chips).toEqual([5]);
    expect(formSchedule(day)).toEqual({ days: [5], start: '00:00', end: '07:00' });
  });
});

describe('the deal form', () => {
  it('names a new deal with the lowest free number and starts at "any time we are open"', () => {
    expect(nextDealName([])).toBe('Deal 1');
    expect(nextDealName([{ name: 'Deal 1' }, { name: 'deal 3' }])).toBe('Deal 2');
    const form = newDealForm([{ name: 'Deal 1' }], key);
    expect(form).toMatchObject({
      name: 'Deal 2',
      timed: false,
      chips: ALL_DAYS,
      allDay: true,
      available: true,
      regularTyped: false,
    });
    expect(formSchedule(form)).toBeUndefined();
  });

  it('turns a saved deal into the form and back without changing it, ids kept', () => {
    const saved: Deal[] = [
      deal(),
      later,
      deal({
        id: 'd-night',
        schedule: {
          days: [6],
          start: '00:00',
          end: '03:00',
          startDate: '2026-11-01',
          endDate: '2026-11-30',
        },
        imageUrl: 'https://example.com/deal.jpg',
        aliases: ['zinger meal', 'ڈیل 1'],
        description: 'Lunch favourite',
      }),
      deal({ id: 'd-day', regularPrice: undefined, schedule: { ...ended.schedule! } }),
    ];
    for (const original of saved) {
      const form = dealToForm(original, key);
      expect(formToBody(form, menu, original.id)).toEqual(dealBody(original));
    }
    const night = dealToForm(saved[2]!, key);
    expect(night).toMatchObject({ chips: [5], allDay: false, start: '00:00', end: '03:00' });
    expect(night.choices[0]!.options.map((o) => [o.id, o.extra])).toEqual([
      ['coke', ''],
      ['sprite', '50'],
    ]);
  });

  it('builds the body the server takes from what the owner typed', () => {
    const form: DealForm = {
      ...newDealForm([], key),
      name: '  Lunch Deal ',
      price: '799',
      items: [
        {
          key: 'a',
          name: 'Chicken Karahi (Full)',
          quantity: 1,
          productId: karahi.id,
          variantId: karahi.variants[1]!.id,
        },
        { key: 'b', name: 'Drink', quantity: 2 },
        { key: 'c', name: '   ', quantity: 1 },
        { key: 'd', name: 'Naan', quantity: 1, variantId: 'orphan' },
      ],
      choices: [
        {
          id: 'g1',
          name: 'Drink ',
          options: [
            { id: 'o1', name: 'Coke', extra: '' },
            { id: 'o2', name: 'Fanta', extra: '50' },
            { id: 'o3', name: ' ', extra: '' },
          ],
        },
      ],
      aliases: 'lunch, Lunch، دوپہر',
      emoji: ' ',
    };
    const body = formToBody(form, menu);
    expect(body).toEqual({
      name: 'Lunch Deal',
      description: '',
      emoji: '🎁',
      aliases: ['lunch', 'دوپہر'],
      price: 79900,
      // Work it out: only the Full karahi can be priced (the drink and naan aren't linked).
      regularPrice: 220000,
      items: [
        {
          name: 'Chicken Karahi (Full)',
          quantity: 1,
          productId: karahi.id,
          variantId: karahi.variants[1]!.id,
        },
        { name: 'Drink', quantity: 2 },
        { name: 'Naan', quantity: 1 },
      ],
      choices: [
        {
          id: 'g1',
          name: 'Drink',
          options: [
            { id: 'o1', name: 'Coke', price: 0 },
            { id: 'o2', name: 'Fanta', price: 5000 },
          ],
        },
      ],
      available: true,
    });
    expect(regularText(form, menu)).toBe('2200');
  });

  it('fills "price if bought separately" from Work it out until the owner types it', () => {
    const form: DealForm = {
      ...newDealForm([], key),
      price: '600',
      items: [
        { key: 'a', name: 'Chicken Biryani', quantity: 1, productId: biryani.id },
        { key: 'b', name: 'Mango Lassi', quantity: 2, productId: lassi.id },
      ],
    };
    expect(regularText(form, menu)).toBe('1010');
    expect(formToBody(form, menu).regularPrice).toBe(101000);
    // Never at or below the deal price.
    expect(regularText({ ...form, price: '1010' }, menu)).toBe('');
    // Typed (even emptied), it is the owner's.
    expect(regularText({ ...form, regularTyped: true, regularPrice: '' }, menu)).toBe('');
    expect(formToBody({ ...form, regularTyped: true, regularPrice: '' }, menu)).not.toHaveProperty(
      'regularPrice',
    );
    expect(regularText({ ...form, regularTyped: true, regularPrice: '1100' }, menu)).toBe('1100');
  });

  it('says what is missing before sending', () => {
    const form: DealForm = {
      ...newDealForm([], key),
      price: '799',
      items: [{ key: 'a', name: 'Zinger', quantity: 1 }],
    };
    expect(formProblem(form)).toBe('');
    expect(formProblem({ ...form, name: ' ' })).toBe('Give the deal a name.');
    expect(formProblem({ ...form, price: '' })).toBe('Enter the deal price.');
    expect(formProblem({ ...form, items: [{ key: 'a', name: '', quantity: 1 }] })).toBe(
      'Add what the deal includes.',
    );
    expect(formProblem({ ...form, items: [{ key: 'a', name: 'Zinger', quantity: 0 }] })).toBe(
      'Give each included item a number from 1 to 50.',
    );
    const choice = { id: 'g', name: 'Drink', options: [{ id: 'o', name: 'Coke', extra: '' }] };
    expect(formProblem({ ...form, choices: [choice] })).toBe('Give Drink at least 2 options.');
    expect(formProblem({ ...form, choices: [{ ...choice, name: '' }] })).toBe(
      'Name each choice, for example Drink.',
    );
    const timed = { ...form, timed: true, chips: [] };
    expect(formProblem(timed)).toBe('Choose at least one day.');
    expect(formProblem({ ...timed, allDay: false, start: '00:00', end: '03:00' })).toBe(
      'Choose at least one night.',
    );
    expect(
      formProblem({ ...form, timed: true, startDate: '2026-11-02', endDate: '2026-11-01' }),
    ).toBe('The end date is before the start date.');
  });

  it('never sends what the server refuses, and says why in plain words', () => {
    const form: DealForm = {
      ...newDealForm([], key),
      price: '799',
      items: [{ key: 'a', name: 'Zinger', quantity: 1 }],
    };
    const option = (name: string, extra = '') => ({ id: key(), name, extra });
    const choice = (name: string, ...options: ReturnType<typeof option>[]) => ({
      id: key(),
      name,
      options,
    });
    const drink = choice('Drink', option('Coke'), option('Sprite'));
    // The server's check of exactly what the editor would send.
    const server = (f: DealForm) => dealSchema.safeParse(formToBody(f, menu)).success;
    const refused: [Partial<DealForm>, string][] = [
      [
        { aliases: Array.from({ length: 11 }, (_, i) => `name ${i}`).join(', ') },
        'Use at most 10 other names (you have 11).',
      ],
      [
        { aliases: 'zinger meal with extra fries and a large drink for lunch time only' },
        'Keep each other name to 60 characters or fewer. “zinger meal with extra f…” is longer.',
      ],
      [
        { choices: [choice('Drink', option('Coke'), option('coke '))] },
        'Drink has coke twice. Keep one of them.',
      ],
      [
        { choices: [drink, choice('drink', option('Coke'), option('Sprite'))] },
        'Two choices are called drink. Give each its own name, such as drink 1 and drink 2.',
      ],
      [
        { choices: [choice('Drink', option('Coke'), option('x'.repeat(101)))] },
        'Keep each option of Drink to 100 characters or fewer.',
      ],
      [
        { choices: [choice('Drink', option('Coke'), option('Lassi', '1000000.01'))] },
        'Enter the extra charge for Lassi up to Rs. 1,000,000, or leave it empty.',
      ],
      [
        { imageUrl: 'http://cdn.example/deal.jpg' },
        'Use a photo link that starts with https://, or leave it empty.',
      ],
      [{ price: '1000000.01' }, 'Keep the deal price to Rs. 1,000,000 or less.'],
      [
        { regularTyped: true, regularPrice: '2000000' },
        'Enter a price if bought separately up to Rs. 1,000,000, or leave it empty.',
      ],
      [{ name: 'x'.repeat(121) }, 'Keep the deal’s name to 120 characters or fewer.'],
      [{ description: 'x'.repeat(501) }, 'Keep the description to 500 characters or fewer.'],
      // Lengths count characters as the server does: an emoji is one, not two.
      [{ emoji: '🍔'.repeat(17) }, 'Use one emoji, or a few at most.'],
      [
        { items: [{ key: 'a', name: 'x'.repeat(101), quantity: 1 }] },
        'Keep each included item’s name to 100 characters or fewer.',
      ],
      [
        { timed: true, allDay: false, start: '', end: '15:00' },
        'Enter the time the deal starts and the time it ends.',
      ],
      [{ timed: true, startDate: '275760-09-13' }, 'Use a real date, or leave it empty.'],
      // Tuesday 20 and Wednesday 21 October 2026, on Fridays only.
      [
        { timed: true, chips: [5], startDate: '2026-10-20', endDate: '2026-10-21' },
        'None of the chosen days falls between the start and end dates.',
      ],
    ];
    for (const [fields, message] of refused) {
      const wrong = { ...form, ...fields };
      expect(formProblem(wrong), message).toBe(message);
      expect(server(wrong), message).toBe(false);
    }
    // Everything the editor lets through, the server keeps: limits at their edge included.
    const kept: Partial<DealForm>[] = [
      {},
      ...WHEN_PRESETS.map((preset) => preset.fill('2026-10-21')),
      { aliases: Array.from({ length: 10 }, (_, i) => `name ${i}`).join(', ') },
      { aliases: `${'x'.repeat(60)}, zinger meal, ڈیل 1` },
      { choices: [drink, choice('Side', option('Fries', '50.25'), option('Raita'))] },
      { choices: [choice('Drink 1', option('Coke'), option('Sprite')), drink] },
      { price: '1000000', regularTyped: true, regularPrice: '1000000' },
      { imageUrl: 'https://cdn.example/deal.jpg', emoji: '🍔🍟🥤', description: 'x'.repeat(500) },
      { emoji: '🍔'.repeat(16), aliases: 'ڈیل'.repeat(20) },
      { timed: true, chips: [5], allDay: false, start: '00:00', end: '03:00' },
    ];
    for (const fields of kept) {
      const fine = { ...form, ...fields };
      expect(formProblem(fine), JSON.stringify(fields)).toBe('');
      expect(server(fine), JSON.stringify(fields)).toBe(true);
    }
    // A problem in the folded "More details" is known as one, so the editor can open it.
    const tooMany = { ...form, aliases: refused[0]![0].aliases! };
    expect(detailsProblem(tooMany)).toBe(formProblem(tooMany));
    const twice: DealForm = { ...form, choices: [drink, drink] };
    expect(detailsProblem(twice)).toBe('');
    expect(formProblem(twice)).not.toBe('');
    // The editor and the server share one set of limits.
    expect([MAX_CHOICES, MAX_OPTIONS]).toEqual([DEAL_LIMITS.choices, DEAL_LIMITS.options]);
  });

  it('fills the When fields from the presets', () => {
    const fill = (id: string) => WHEN_PRESETS.find((p) => p.id === id)!.fill('2026-10-21');
    expect(WHEN_PRESETS.map((p) => p.label)).toEqual([
      'Lunch (Mon–Fri 12:00–15:00)',
      'Late night (every night 00:00–03:00)',
      'One day',
      'Between dates (e.g. Ramadan)',
    ]);
    const base = newDealForm([], key);
    expect(formSchedule({ ...base, ...fill('lunch') })).toEqual({
      days: [1, 2, 3, 4, 5],
      start: '12:00',
      end: '15:00',
    });
    expect(formSchedule({ ...base, ...fill('late') })).toEqual({
      days: ALL_DAYS,
      start: '00:00',
      end: '03:00',
    });
    expect(formSchedule({ ...base, ...fill('day') })).toEqual({
      days: ALL_DAYS,
      start: '00:00',
      end: '00:00',
      startDate: '2026-10-21',
      endDate: '2026-10-21',
    });
    expect(formSchedule({ ...base, ...fill('dates') })).toMatchObject({
      startDate: '2026-10-21',
    });
  });

  it('words the times plainly and questions a window over 12 hours', () => {
    expect(timeWords('00:00')).toBe('midnight (00:00)');
    expect(timeWords('12:00')).toBe('noon (12:00)');
    expect(timeWords('18:30')).toBe('18:30');
    expect(runsText({ allDay: false, start: '00:00', end: '03:00' })).toBe(
      'Runs from midnight (00:00) to 03:00.',
    );
    expect(runsText({ allDay: false, start: '23:00', end: '02:00' })).toBe(
      'Runs from 23:00 to 02:00 the next day.',
    );
    expect(runsText({ allDay: true, start: '12:00', end: '15:00' })).toBe('');
    expect(windowMinutes('12:00', '03:00')).toBe(15 * 60);
    expect(windowMinutes('09:00', '09:00')).toBe(1440);
    // "Raat 12 se 3" picked as 12:00 PM on a 12-hour phone picker.
    expect(longWindowNote({ allDay: false, start: '12:00', end: '03:00' })).toBe(
      'This runs 15 hours. Did you mean 12 am (midnight)?',
    );
    expect(longWindowNote({ allDay: false, start: '08:00', end: '23:30' })).toBe(
      'This runs 15.5 hours.',
    );
    expect(longWindowNote({ allDay: false, start: '12:00', end: '15:00' })).toBe('');
    expect(longWindowNote({ allDay: true, start: '12:00', end: '03:00' })).toBe('');
  });

  it('warns on save about a deal that has ended or starts later', () => {
    const clock = localClock(company.timezone, NOW);
    expect(scheduleNotice(ended.schedule, clock)).toBe(
      'Its end date has passed, so customers won’t see it.',
    );
    expect(
      scheduleNotice(
        { days: ALL_DAYS, start: '00:00', end: '00:00', startDate: '2026-11-02' },
        clock,
      ),
    ).toBe('It starts on 2 Nov 2026.');
    expect(scheduleNotice(later.schedule, clock)).toBe('');
    expect(scheduleNotice(undefined, clock)).toBe('');
    expect(dayWords('2026-08-14')).toBe('14 Aug 2026');
    // Saved at 01:00 on its start date, a late deal is still before its first night (the night
    // of 22 Oct runs until 02:00): it starts that evening, as the menu says.
    const late = { days: ALL_DAYS, start: '23:00', end: '02:00', startDate: '2026-10-22' };
    const night = { ...late, start: '00:00', end: '03:00' };
    const oneAm = localClock(company.timezone, '2026-10-21T20:00:00.000Z');
    expect(scheduleNotice(late, oneAm)).toBe('It starts on 22 Oct 2026.');
    expect(scheduleNotice(night, oneAm)).toBe('It starts on 22 Oct 2026.');
    expect(scheduleNotice(late, localClock(company.timezone, '2026-10-22T18:30:00.000Z'))).toBe('');
  });

  it('copies a choice with new ids, numbering the set and keeping it together', () => {
    let n = 0;
    const id = () => `new${++n}`;
    const drink = {
      id: 'g1',
      name: 'Drink',
      options: [
        { id: 'o1', name: 'Coke', extra: '' },
        { id: 'o2', name: 'Fanta', extra: '50' },
      ],
    };
    const side = { id: 'g2', name: 'Side', options: [] };
    const once = copyChoice([drink, side], 0, id);
    expect(once.map((g) => [g.id, g.name])).toEqual([
      ['g1', 'Drink 1'],
      ['new1', 'Drink 2'],
      ['g2', 'Side'],
    ]);
    expect(once[1]!.options).toEqual([
      { id: 'new2', name: 'Coke', extra: '' },
      { id: 'new3', name: 'Fanta', extra: '50' },
    ]);
    // Copying the first of a set adds the next number after the set.
    const twice = copyChoice(once, 0, id);
    expect(twice.map((g) => g.name)).toEqual(['Drink 1', 'Drink 2', 'Drink 3', 'Side']);
    const ids = twice.flatMap((g) => [g.id, ...g.options.map((o) => o.id)]);
    expect(new Set(ids).size).toBe(ids.length);
    // Five choices at most.
    const five = [...twice, { ...side, id: 'g9', name: 'Sauce' }];
    expect(copyChoice(five, 0, id)).toBe(five);
  });

  it('adds options typed with commas, skipping names already there', () => {
    let n = 0;
    const id = () => `o${++n}`;
    const options = optionsFromText(
      'Coke, Sprite,, fanta، 7up , coke',
      [
        { id: 'x', name: 'Fanta', extra: '50' },
        { id: 'y', name: '', extra: '' },
      ],
      id,
    );
    expect(options).toEqual([
      { id: 'x', name: 'Fanta', extra: '50' },
      { id: 'o1', name: 'Coke', extra: '' },
      { id: 'o2', name: 'Sprite', extra: '' },
      { id: 'o3', name: '7up', extra: '' },
    ]);
  });

  it('warns when a deal is called the same as a menu item or another deal', () => {
    expect(sameNameWarning(['Chicken Biryani', ''], menu, [], undefined)).toBe(
      'Same name as Chicken Biryani on your menu. The bot will ask customers which one they mean.',
    );
    expect(sameNameWarning(['deal 1'], menu, [deal()], undefined)).toBe(
      'Same name as Deal 1 in your deals. The bot will ask customers which one they mean.',
    );
    // A deal is not its own duplicate.
    expect(sameNameWarning(['Deal 1'], menu, [deal()], 'd-on')).toBe('');
    // Other names count too, on both sides.
    expect(sameNameWarning(['biryani'], menu, [], undefined)).toContain('Chicken Biryani');
  });

  it('says what the bot does with a paused or ended deal of the same name', () => {
    // The bot sells the deal that is on; it asks which one only once both are on.
    expect(sameNameWarning(['Deal 1'], menu, [{ ...deal(), state: 'paused' }], 'd-new')).toBe(
      'Same name as Deal 1 (paused) in your deals. While it is off, the bot sells this one; if it comes back on, the bot will ask customers which one they mean.',
    );
    expect(
      sameNameWarning(
        ['Deal 1'],
        menu,
        [
          { ...deal(), state: 'ended' },
          { ...deal({ id: 'd-two' }), state: 'paused' },
        ],
        'd-new',
      ),
    ).toBe(
      'Same name as Deal 1 (ended) and Deal 1 (paused) in your deals. While they are off, the bot sells this one; if one comes back on, the bot will ask customers which one they mean.',
    );
    // On now, later today or sold out: still asked about.
    for (const state of ['on', 'later', 'sold_out'] as const)
      expect(sameNameWarning(['Deal 1'], menu, [{ ...deal(), state }], 'd-new')).toBe(
        'Same name as Deal 1 in your deals. The bot will ask customers which one they mean.',
      );
  });

  it('counts names that differ only by punctuation or spacing as the same, as the bot does', () => {
    expect(sameNameWarning(['Deal-1'], menu, [deal()], 'd-new')).toBe(
      'Same name as Deal 1 in your deals. The bot will ask customers which one they mean.',
    );
    // The same name as a menu item, not a longer name with "biryani" in it.
    expect(sameNameWarning(['Chicken-Biryani'], menu, [], undefined)).toBe(
      'Same name as Chicken Biryani on your menu. The bot will ask customers which one they mean.',
    );
    expect(sameNameWarning(['  chicken   biryani! '], menu, [], undefined)).toBe(
      'Same name as Chicken Biryani on your menu. The bot will ask customers which one they mean.',
    );
  });

  it('warns when a deal’s name is part of a menu item’s name, or has one in it', () => {
    // "zinger" for a Zinger Deal, with Zinger Burger on the menu: the bot may sell the deal to
    // someone ordering the burger, so the owner is told before saving.
    const burger = { ...biryani, id: 'p-zinger', name: 'Zinger Burger', aliases: [] };
    expect(sameNameWarning(['Zinger Deal', 'zinger'], [...menu, burger], [], 'd')).toBe(
      '“zinger” is also part of Zinger Burger on your menu, so the bot may take an order for Zinger Burger as this deal. Use a longer name that isn’t part of a menu item’s name.',
    );
    // Through a menu item's other names too, in any script, naming at most three items.
    expect(sameNameWarning(['Deal 1', 'chicken'], menu, [], undefined)).toBe(
      '“chicken” is also part of Chicken Biryani, Chicken Karahi and Chicken Tikka on your menu, so the bot may take an order for one of them as this deal. Use a longer name that isn’t part of a menu item’s name.',
    );
    const wings = ['Wings', 'Wraps', 'Rolls'].map((name, i) => ({
      ...biryani,
      id: `p-${i}`,
      name: `Chicken ${name}`,
      aliases: [],
    }));
    expect(sameNameWarning(['chicken'], [...menu, ...wings], [], undefined)).toContain(
      'part of Chicken Biryani, Chicken Karahi, Chicken Tikka and others on your menu',
    );
    expect(sameNameWarning(['مکھنی'], menu, [], undefined)).toContain('Daal Makhani');
    // The other way round: the deal's name has a menu item's name in it.
    expect(sameNameWarning(['Biryani Deal'], menu, [], undefined)).toBe(
      'To order “Biryani Deal” in chat, customers need its full name: “biryani” alone orders Chicken Biryani.',
    );
    expect(sameNameWarning(['Biryani Lassi Deal'], menu, [], undefined)).toBe(
      'To order “Biryani Lassi Deal” in chat, customers need its full name: “biryani” alone orders Chicken Biryani and “lassi” alone orders Mango Lassi.',
    );
    // Whole words only, and nothing for names that share no words.
    expect(sameNameWarning(['Deal 1', 'zing'], [...menu, burger], [], undefined)).toBe('');
    expect(sameNameWarning(['Family Deal', 'family meal'], menu, [], undefined)).toBe('');
    // A name the same as a menu item's is said once, as the same name.
    expect(sameNameWarning(['Chicken Biryani'], menu, [], undefined)).toBe(
      'Same name as Chicken Biryani on your menu. The bot will ask customers which one they mean.',
    );
  });

  it('offers the best six menu items for what is typed, and names a size', () => {
    expect(menuMatches('chick', menu).map((p) => p.name)).toEqual([
      'Chicken Biryani',
      'Chicken Karahi',
      'Chicken Tikka',
    ]);
    expect(menuMatches('kebab', menu).map((p) => p.name)).toEqual(['Beef Seekh Kebab']);
    expect(menuMatches(' ', menu)).toEqual([]);
    expect(menuMatches('a', menu).length).toBeLessThanOrEqual(6);
    expect(linkedName(karahi)).toBe('Chicken Karahi');
    expect(linkedName(karahi, karahi.variants[1]!.id)).toBe('Chicken Karahi (Full)');
  });
});

describe('deal card warnings', () => {
  it('names the sold-out item and spots a stale "bought separately"', () => {
    expect(soldOutItem(soldOut, menu)).toBe('Daal Makhani');
    expect(soldOutItem(deal(), menu)).toBeUndefined();
    expect(staleRegularPrice(stale, menu)).toBe(73000);
    expect(staleRegularPrice(deal(), menu)).toBeUndefined();
    // Only when every item can be priced.
    expect(
      staleRegularPrice(
        { ...stale, items: [...stale.items, { name: 'Drink', quantity: 1 }] },
        menu,
      ),
    ).toBeUndefined();
    expect(staleRegularPrice(deal({ regularPrice: undefined }), menu)).toBeUndefined();
  });

  it('says when a deal’s times fall outside opening hours', () => {
    const hours = { start: '12:00', end: '23:00', days: ALL_DAYS };
    expect(openingWarning({ days: ALL_DAYS, start: '00:00', end: '03:00' }, hours)).toBe(
      'Never while you’re open: customers can’t order it at these times.',
    );
    expect(openingWarning({ days: [1, 2, 3, 4, 5], start: '11:00', end: '15:00' }, hours)).toBe(
      'You’re closed for part of this deal’s times: Mon–Fri 11:00–12:00. Customers can’t order it then.',
    );
    expect(openingWarning({ days: [1, 2, 3, 4, 5], start: '12:00', end: '15:00' }, hours)).toBe('');
    // An all-day deal means "whenever we're open on those days".
    expect(openingWarning({ days: [5], start: '00:00', end: '00:00' }, hours)).toBe('');
    expect(openingWarning(undefined, hours)).toBe('');
  });

  it('puts a saved deal and a new order into the workspace', () => {
    const data = { deals: [deal(), later] };
    const changed = withDeal(data, { ...later, name: 'Dinner Deal' });
    expect(changed.deals.map((d) => d.name)).toEqual(['Deal 1', 'Dinner Deal']);
    expect(withDeal(data, paused).deals).toHaveLength(3);
    const ordered = withOrder({ deals: [deal(), later, soldOut] }, ['d-sold', 'd-on']);
    expect(
      ordered.deals.map((d) => [d.id, d.position]).sort((a, b) => Number(a[1]) - Number(b[1])),
    ).toEqual([
      ['d-sold', 1],
      ['d-on', 2],
      ['d-later', 3],
    ]);
  });
});

describe('the Deals page', () => {
  const page = (role: 'owner' | 'staff', deals = all, extra = {}) =>
    render(Deals, bootstrap({ role, deals, ...extra }), 'deals');

  it('groups deals by what they are doing now, with ended ones folded away', () => {
    const html = page('owner');
    const at = ['On now · 3', 'Later · 1', 'Sold out · 1', 'Paused · 1', 'Ended (1)'].map((text) =>
      html.indexOf(text),
    );
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(html).not.toContain('Eid Deal');
    // The card: price, saving, what it includes, the choice, when.
    expect(html).toContain('Rs. 600');
    expect(html).toContain('You save Rs. 130');
    expect(html).toContain('1 × Chicken Biryani · 1 × Mango Lassi');
    expect(html).toContain('Coke, Sprite (+Rs. 50)');
    expect(html).toContain('Any time you’re open');
    // A later deal says when it is on; a sold-out one names the item.
    expect(html).toContain('Mon–Fri 18:00–22:00');
    expect(html).toContain('Sold out: Daal Makhani');
  });

  it('lets the owner add, edit, pause, delete and reorder, with warnings to act on', () => {
    const html = page('owner');
    for (const text of [
      'Add deal',
      'Reorder',
      'aria-label="Edit Deal 1"',
      'aria-label="Pause: Deal 1"',
      'aria-label="Resume: Paused Deal"',
      'aria-label="Delete Deal 1"',
      'Zinger burger is no longer on your menu — pick again or keep as text.',
      'Prices changed: bought separately is now Rs. 730 (you show Rs. 1,049).',
      '>Update</button>',
      RELOAD_NOTE,
    ])
      expect(html, text).toContain(text);
  });

  it('shows staff what is on, read-only', () => {
    const html = page('staff');
    expect(html).toContain('Deal 1');
    expect(html).toContain('On now');
    expect(html).toContain('Mon–Fri 18:00–22:00');
    for (const text of [
      'Add deal',
      'Reorder',
      'Edit Deal 1',
      'Pause:',
      'Resume:',
      'Delete Deal 1',
      'Prices changed',
      'no longer on your menu',
      RELOAD_NOTE,
    ])
      expect(html, text).not.toContain(text);
  });

  it('warns the owner when a deal runs while the restaurant is closed', () => {
    const html = page('owner', [later], {
      company: { ...company, openingHours: { start: '09:00', end: '20:00', days: ALL_DAYS } },
    });
    expect(html).toContain(
      'You’re closed for part of this deal’s times: Mon–Fri 20:00–22:00. Customers can’t order it then.',
    );
  });

  it('starts empty with an example, and points at old "Deals" menu items', () => {
    const owner = page('owner', []);
    expect(owner).toContain('No deals yet');
    expect(owner).toContain('“Deal 1: Zinger + fries + drink, Rs 799”');
    expect(owner).toContain('Add your first deal');
    expect(owner).not.toContain('“Deals” category');
    expect(owner).not.toContain(RELOAD_NOTE);
    const legacy: Product = { ...biryani, id: 'legacy', name: 'Old Combo', category: ' deals ' };
    const withLegacy = page('owner', [], { products: [...menu, legacy] });
    expect(withLegacy).toContain(
      'You also have 1 item in a “Deals” category on your Menu tab. They still sell as normal items.',
    );
    expect(page('staff', [])).not.toContain('Add your first deal');
    // A server older than deals sends none.
    expect(render(Deals, bootstrap(), 'deals')).toContain('No deals yet');
  });

  it('follows the clock: the same deal is later in the morning and on at lunch', () => {
    const lunch = deal({ schedule: { days: [1, 2, 3, 4, 5], start: '12:00', end: '15:00' } });
    expect(page('staff', [lunch])).toContain('On now · 1');
    vi.setSystemTime(new Date('2026-10-21T04:00:00.000Z'));
    expect(page('staff', [lunch])).toContain('Later · 1');
  });
});

describe('the deal editor', () => {
  const editor = (target?: Deal, deals: Deal[] = [deal()]) =>
    render(
      function Editor() {
        return createElement(DealEditor, { deal: target, onDone: () => {} });
      },
      bootstrap({ deals }),
      'deals',
    );

  it('opens a new deal with the next name, the basics and the collapsed parts', () => {
    const html = editor();
    expect(html).toContain('value="Deal 2"');
    const at = [
      'What’s included',
      'Add item',
      'Price if bought separately',
      'Add a choice (e.g. Drink)',
      'Any time we’re open',
      'Lunch (Mon–Fri 12:00–15:00)',
      'More details',
      'Deal is on (customers can order it)',
      'Save deal',
    ].map((text) => html.indexOf(text));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // Collapsed until asked for.
    expect(html).not.toContain('Which days?');
    expect(html).not.toContain('Photo link');
    expect(html).not.toContain('Copy this choice');
  });

  it('shows a night deal as the nights the owner ticked, in the restaurant’s time zone', () => {
    const night = deal({
      choices: [],
      schedule: { days: [6], start: '00:00', end: '03:00' },
    });
    const html = editor(night);
    expect(html).toContain('Which nights?');
    expect(html).toMatch(/checked=""\/>Fri night/);
    expect(html).not.toMatch(/checked=""\/>Sat night/);
    expect(html).toContain('Fri night 00:00–03:00');
    expect(html).toContain('Runs from midnight (00:00) to 03:00.');
    expect(html).toContain('Times are in Asia/Karachi.');
  });

  it('keeps a saved deal’s choices editable, and flags a link to a removed item', () => {
    const html = editor(deal({ items: [...deal().items, ...broken.items] }));
    expect(html).toContain('Copy this choice');
    expect(html).toContain('Options, separated by commas');
    expect(html).toContain(
      'Linked to <strong class="font-semibold text-ink">Chicken Biryani</strong>',
    );
    expect(html).toContain('Zinger burger is no longer on your menu — pick again or keep as text.');
    expect(html).toContain('Keep as text');
    expect(html).toContain('Customers save Rs. 130');
  });

  it('asks for a size when a linked item has sizes, and says what was not counted', () => {
    const html = editor(
      deal({
        regularPrice: undefined,
        items: [
          { name: 'Chicken Karahi', quantity: 1, productId: karahi.id },
          { name: 'Drink', quantity: 1 },
        ],
      }),
    );
    expect(html).toContain('Choose a size');
    expect(html).toContain('Not counted: Chicken Karahi (no size), Drink (not linked)');
  });

  it('warns about a name the menu already uses', () => {
    expect(editor(deal({ name: 'Chicken Biryani' }), [])).toContain(
      'Same name as Chicken Biryani on your menu.',
    );
    // An other name that is part of dishes' names, next to the deal's name where it is seen.
    expect(editor(deal({ aliases: ['chicken'] }), [])).toContain(
      '“chicken” is also part of Chicken Biryani, Chicken Karahi',
    );
    // Another deal of the name that is paused is said to be off, as the bot treats it.
    const beside = editor(deal({ id: 'd-new' }), [deal({ available: false })]);
    expect(beside).toContain('Same name as Deal 1 (paused) in your deals. While it is off');
    expect(beside).not.toContain('Same name as Deal 1 in your deals.');
  });
});

describe('Test your bot with deals', () => {
  const TestBot = () => createElement(Playground);
  const deals = [deal(), later, paused, soldOut];

  it('lists deals first, a later one not addable with its times, and never a paused one', () => {
    const html = render(TestBot, bootstrap({ deals }), 'playground');
    const list = html.slice(html.indexOf('On the menu'));
    expect(list.indexOf('Deal 1')).toBeGreaterThan(0);
    expect(list.indexOf('Deal 1')).toBeLessThan(list.indexOf('Chicken Biryani'));
    expect(list).toContain('Rs. 600 · Not on now · Mon–Fri 18:00–22:00');
    expect(list).toMatch(/disabled="" title="Not on now · Mon–Fri 18:00–22:00"/);
    expect(list).toContain('Rs. 600 · Sold out');
    expect(list).not.toContain('Paused Deal');
  });

  it('is unchanged for a restaurant without deals', () => {
    const plain = render(TestBot, bootstrap(), 'playground');
    expect(render(TestBot, bootstrap({ deals: [] }), 'playground')).toBe(plain);
    expect(plain).not.toContain('Not on now');
  });

  it('asks for each choice by its own name, with nothing picked, and words the message', () => {
    const clock = localClock(company.timezone, NOW);
    const product = dealProduct(deal(), dealState(deal(), menu, clock), clock, 'Deals');
    const html = renderToMarkup(
      createElement(AddItem, { product, loading: false, close: () => {}, add: async () => {} }),
    );
    expect(html).toContain('<legend class="field-label">Drink</legend>');
    expect(html).not.toContain('Size');
    expect(html).toContain('Includes: 1 × Chicken Biryani · 1 × Mango Lassi');
    expect(html.match(/type="radio" required="" name="pick-drink"/g)).toHaveLength(2);
    expect(html).not.toMatch(/type="radio"[^>]*checked/);
    expect(html).toContain('+ Rs. 50');
    const add = { type: 'add_item' as const, productId: product.id, quantity: 2, notes: '' };
    expect(addText(product, { ...add, modifierIds: ['sprite'] })).toBe('Add 2 Deal 1 with Sprite');
    const two = {
      ...deal().choices[0]!,
      id: 'side',
      name: 'Side',
      options: [
        { id: 'fries', name: 'Fries', price: 0 },
        { id: 'raita', name: 'Raita', price: 0 },
      ],
    };
    const combo = {
      ...product,
      deal: { ...product.deal!, choices: [...product.deal!.choices, two] },
    };
    expect(addText(combo, { ...add, modifierIds: ['fries', 'coke'], notes: 'less spicy' })).toBe(
      'Add 2 Deal 1 with Coke / Fries, note: less spicy',
    );
    // A menu item's message is as before.
    expect(
      addText(karahi, {
        ...add,
        productId: karahi.id,
        variantId: karahi.variants[1]!.id,
        modifierIds: [karahi.modifiers[0]!.id],
        notes: 'spicy',
      }),
    ).toBe('Add 2 Chicken Karahi, option Full, with Extra butter, note: spicy');
  });

  it('prices a cart holding a deal from the deals as they are now', () => {
    const source = readFileSync('src/components/Conversations.tsx', 'utf8');
    expect(source).toContain('quoteCart(data.company, catalog, conversation.cart)');
    expect(source).toMatch(
      /sellableCatalog\(\s*data\.company,\s*data\.products,\s*data\.deals \?\? \[\],/,
    );
    expect(source).toContain('keepIds: conversation?.cart.items.map((item) => item.productId)');
    // The cart total the panel shows is the quote's.
    const catalog = sellableCatalog(company, menu, [deal()], NOW, { keepIds: ['d-on'] });
    expect(catalog[0]!.id).toBe('d-on');
  });
});

describe('the order view', () => {
  it('shows what a deal line includes under its picks', () => {
    const source = readFileSync('src/components/Orders.tsx', 'utf8');
    const line = source.slice(
      source.indexOf('{item.variant && <p'),
      source.indexOf('{item.notes && ('),
    );
    expect(line).toContain('Array.isArray(item.includes) && item.includes.length > 0');
    expect(line).toContain("Includes: {item.includes.join(' · ')}");
    expect(line.indexOf('item.variant')).toBeLessThan(line.indexOf('item.includes'));
  });
});

describe('the Menu tab', () => {
  it('points to the Deals tab', () => {
    const html = render(Catalog, bootstrap(), 'menu');
    expect(html).toContain('Combos and time-limited offers live in');
    expect(html).toContain('>Deals</button>');
  });
});

describe('Agent flow', () => {
  it('counts the deals on now only for a business with deals', async () => {
    vi.useRealTimers();
    const repo = new MemoryRepository();
    const target = (await repo.getCompany(company.id))!;
    const menuNode = async () =>
      (await buildAgentFlow(repo, target, 'owner')).nodes.find((n) => n.id === 'menu')!;
    const before = await menuNode();
    expect(before.facts.map((f) => f.label)).not.toContain('Deals');
    expect(before.subtitle).toBe('7 of 8 items available');
    await repo.saveDeal(deal({ id: '0a0a0a0a-0000-4000-8000-000000000001' }));
    await repo.saveDeal(deal({ id: '0a0a0a0a-0000-4000-8000-000000000002', available: false }));
    const after = await menuNode();
    expect(after.facts.find((f) => f.label === 'Deals')?.value).toBe('1 on now of 2');
    expect(after.subtitle).toBe('7 of 8 items available');
  });

  it('names deals in a reply’s replay and reloads when deals change', () => {
    const source = readFileSync('src/components/AgentFlow.tsx', 'utf8');
    expect(source).toContain('data.deals?.find((deal) => deal.id === id)?.name ??');
    expect(source).toMatch(/data\.products\?\.length,\s*data\.deals\?\.length,/);
  });
});

function renderToMarkup(element: ReturnType<typeof createElement>) {
  return render(
    function Wrapper() {
      return element;
    },
    bootstrap(),
    'playground',
  );
}
