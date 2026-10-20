import { describe, expect, it } from 'vitest';
import {
  CORPUS,
  exception,
  HEAD,
  MAIN,
  menus,
  namesNoDeal,
  readBoth,
  states,
  withDeals,
  WRITTEN,
  type State,
} from './helpers/no-deal-parity';

// DEALS-DESIGN amendment v3. A1: a restaurant without deals reads every message exactly as main
// (c5704f5) did, but for (b) a deal word never matching a dish by a typo, and (d) a message only
// of deal words and fillers asking for the deals. A2: with deals, the dishes of a message are
// still read as main reads them. Main's engine is vendored in tests/fixtures/main-c5704f5.

// The corpus messages read apart from main on some menu without deals, and why. Each one must
// differ only as its exception says (see exception() in the helper).
const EXCEPTIONS = new Map<string, 'b' | 'd'>([
  // (b) "deal" is no typo of "daal" (Dastarkhwan's Daal Makhani) or "meal", nor "deals" of
  // "deal" (dishes named Deal 1, 2 and 3).
  ...(
    [
      'deal 1',
      'deal 2 please',
      '2 deal 3',
      'deal no 1',
      'deal 1 and deal 2',
      'deal 2 and 3',
      'deal 1 x2',
      'deal 1 chahiye',
      'deal 2 de do',
      'do deal 3',
      'deal 1 aur deal 2 chahiye',
      'tell me about deal 1',
      'deal 1 kitne ki hai',
      'deal 1\ndeal 2',
      '2 deal 1 aur 3 deal 2',
      'deal 1, 2 pepsi',
      'zinger burger 2 deal 1',
      'fries aur 2 deal 1',
      'deal chahiye',
      'ek deal dena',
      'lunch deal',
      'midnight deal dena',
      'student deal',
      'student deal chahiye',
      'family deal',
      'deal 4',
      'deal 12',
      '1 deal 2 chahiye',
      '2 deal 2',
      '2 deal 2 de do',
      'ek deal 2 please',
      'do deal 2 chahiye',
      'teen deal 2',
      'teen deal 2 de do',
      'deal 2 x2 please',
      '۲ deal 2 chahiye',
      'deals 2',
      '2 deals',
    ] as const
  ).map((text) => [text, 'b'] as const),
  // (d) Only deal words and fillers: the deals are shown.
  ...(
    [
      'deal',
      'deals',
      'deals?',
      'koi deal hai?',
      'deal hai kya',
      'any deals?',
      'any offers?',
      'what deals do you have',
      'deals dikhao',
      'koi offer hai',
      'offers?',
      'combo?',
      'combos',
      'ڈیل',
      'ڈیلز',
      'deal price?',
      'koi achi deal batao',
      'today’s deals',
      'deals kya hain',
      'aaj ki deal',
      'combo offer',
    ] as const
  ).map((text) => [text, 'd'] as const),
]);
const STATES: State[] = ['fresh', 'asked', 'review'];

describe('the corpus', () => {
  it('has 400 messages or more in English, Roman Urdu and Urdu, some one item per line', () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(400);
    expect(CORPUS.filter((text) => /\p{Script=Arabic}/u.test(text)).length).toBeGreaterThan(30);
    expect(CORPUS.filter((text) => text.includes('\n')).length).toBeGreaterThan(5);
    expect(WRITTEN.length).toBeGreaterThanOrEqual(300);
    for (const text of EXCEPTIONS.keys()) expect(CORPUS).toContain(text);
  });
});

describe.each(menus.map((menu) => [menu.name, menu] as const))(
  'on %s, without deals',
  (_name, menu) => {
    const chats = states(menu);
    it.each(STATES)(
      'reads every message in a %s chat as main does: parse, local turn and AI turns',
      (state) => {
        const apart: string[] = [];
        for (const text of state === 'fresh' ? CORPUS : WRITTEN) {
          const { main, head } = readBoth(menu, chats[state], text);
          const keys = (Object.keys(main) as (keyof typeof main)[]).filter(
            (key) => main[key] !== head[key],
          );
          if (!keys.length) continue;
          const why = exception(menu, text, main, head);
          if (!why || EXCEPTIONS.get(text) !== why)
            apart.push(
              `${JSON.stringify(text)} [${keys.join(', ')}] (${why ?? 'no exception'})\n  main ${main.parse}\n  head ${head.parse}`,
            );
        }
        expect(apart).toEqual([]);
      },
    );
  },
);

describe('the exceptions', () => {
  it('each read apart from main on some menu without deals', () => {
    const same = [...EXCEPTIONS.keys()].filter((text) =>
      menus.every((menu) => {
        const chats = states(menu);
        return STATES.every((state) => {
          const { main, head } = readBoth(menu, chats[state], text);
          return main.parse === head.parse && main.local === head.local;
        });
      }),
    );
    expect(same).toEqual([]);
  });

  it('show the deals for a deal question, and never a typo of a deal word', () => {
    const [dastarkhwan] = menus;
    const chat = states(dastarkhwan!).fresh;
    const daal = dastarkhwan!.products.find((p) => p.name === 'Daal Makhani')!;
    for (const text of ['koi deal hai?', 'deals?', 'any offers?', 'deal hai kya', 'deals dikhao'])
      expect(HEAD.parseActions(dastarkhwan!.company, dastarkhwan!.products, chat, text)).toEqual([
        { type: 'menu', query: 'deals' },
      ]);
    for (const text of ['deal chahiye', 'deal 1', 'lunch deal'])
      expect(
        JSON.stringify(HEAD.parseActions(dastarkhwan!.company, dastarkhwan!.products, chat, text)),
      ).not.toContain(daal.id);
    // Main read them as the daal.
    expect(
      MAIN.parseActions(dastarkhwan!.company, dastarkhwan!.products, chat, 'deal chahiye'),
    ).toEqual([{ type: 'add_item', productId: daal.id, quantity: 1, modifierIds: [] }]);
  });
});

describe.each(menus.map((menu) => [menu.name, menu] as const))(
  'on %s, with deals',
  (_name, menu) => {
    const chats = states(menu);
    const catalog = withDeals(menu);
    it('reads the dishes of a message naming no deal as main does on the dishes alone', () => {
      const apart: string[] = [];
      let read = 0;
      for (const text of CORPUS.filter((text) => namesNoDeal(menu, text)))
        for (const state of ['fresh', 'asked'] as const) {
          read++;
          const main = JSON.stringify(
            MAIN.parseActions(menu.company, menu.products, chats[state], text),
          );
          const head = JSON.stringify(HEAD.parseActions(menu.company, catalog, chats[state], text));
          if (main !== head)
            apart.push(`${state} ${JSON.stringify(text)}\n  main ${main}\n  head ${head}`);
        }
      expect(read).toBeGreaterThan(600);
      expect(apart).toEqual([]);
    });
  },
);
