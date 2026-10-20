import type { Conversation, DealChoiceOption, Product } from '../shared/types';

/**
 * Words that ask for deals in general rather than name one: "deal", "combo", "offer", "meal",
 * "ڈیل". All but "meal" never match a dish by a typo ("deal" is one letter from "daal").
 */
export const DEAL_WORDS = new Set([
  'deal',
  'deals',
  'combo',
  'combos',
  'offer',
  'offers',
  'meal',
  'meals',
  'ڈیل',
  'ڈیلز',
  'ڈیلیں',
]);
// Of those, the ones that only ever mean deals. "combo", "offer" and "meal" may also be a word of
// a dish's own name ("Kids Meal", "Family Combo").
export const ONLY_DEAL_WORDS = new Set(['deal', 'deals', 'ڈیل', 'ڈیلز', 'ڈیلیں']);
// The deal words that never match a dish by a typo, on any menu. "meal" is as much a dish's word
// ("Kids Meal") as a deal's, so it is read as main reads it.
const NO_TYPO_WORDS = new Set([...DEAL_WORDS].filter((word) => !/^meals?$/u.test(word)));

const STOP_WORDS = new Set([
  'add',
  'and',
  'can',
  'chahiye',
  'chahye',
  'do',
  'for',
  'give',
  'have',
  'item',
  'kardo',
  'address',
  'delivery',
  'hai',
  'karna',
  'krdo',
  'menu',
  'mera',
  'mujhe',
  'my',
  'naam',
  'nam',
  'name',
  'order',
  'pickup',
  'please',
  'the',
  'want',
  'with',
  'you',
  'i',
  'id',
  'd',
  'like',
  'to',
  'a',
  'an',
  'one',
  'two',
  'three',
  'what',
  'which',
  'on',
  'is',
  'there',
  'me',
  'some',
]);

export function normalizeCatalogText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f\u064b-\u065f]/g, '')
    .replace(/[۰-۹٠-٩]/g, (digit) =>
      String(
        '۰۱۲۳۴۵۶۷۸۹'.includes(digit) ? '۰۱۲۳۴۵۶۷۸۹'.indexOf(digit) : '٠١٢٣٤٥٦٧٨٩'.indexOf(digit),
      ),
    )
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function containsPhrase(text: string, phrase: string): boolean {
  return ` ${text} `.includes(` ${phrase} `);
}

/** Damerau-Levenshtein distance with adjacent transpositions. */
export function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const matrix = Array.from({ length: rows }, () => Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i++) matrix[i]![0] = i;
  for (let j = 0; j < cols; j++) matrix[0]![j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i]![j] = Math.min(
        matrix[i - 1]![j]! + 1,
        matrix[i]![j - 1]! + 1,
        matrix[i - 1]![j - 1]! + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        matrix[i]![j] = Math.min(matrix[i]![j]!, matrix[i - 2]![j - 2]! + cost);
    }
  }
  return matrix[a.length]![b.length]!;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  a: 1,
  an: 1,
  ek: 1,
  aik: 1,
  ایک: 1,
  two: 2,
  do: 2,
  دو: 2,
  three: 3,
  teen: 3,
  تین: 3,
  four: 4,
  char: 4,
  چار: 4,
  five: 5,
  panch: 5,
  پانچ: 5,
};
// Roman Urdu "do" (Urdu "دو") is also "give": "biryani de do", "tikka do na", "kar do". It is a
// count only before another word that is not a softener, and never straight after a verb.
const GIVE_VERBS = new Set(
  'de dey day kar kr karr le lay bhej bhij la laa rehne rehnay bana dikha bata laga rakh mangwa hata nikal dila دے کر لے بھیج لا دلا دکھا بتا بنا'.split(
    ' ',
  ),
);
const SOFTENERS = new Set(
  'na naa nah please pls plz plzz bhai bhaiya yaar yar ji jee g sir jaldi zara mujhe mjhe hamein humein hume isay usay abhi نا پلیز جی بھائی مجھے ہمیں ذرا جلدی ابھی'.split(
    ' ',
  ),
);
function countsAsNumber(tokens: string[], index: number): boolean {
  if (tokens[index] !== 'do' && tokens[index] !== 'دو') return true;
  const next = tokens[index + 1];
  return !!next && !SOFTENERS.has(next) && !GIVE_VERBS.has(tokens[index - 1] ?? '');
}

const isNumber = (word: string | undefined) => !!word && /^\d+$/.test(word);
// Deal names holding a number ("Deal 2"), as words. Their number is part of the name, never a
// count, and a bare number after one may name another deal ("deal 2 and 3"). Dishes count as
// they always have ("Platter 1", "Sprite 1.5L").
const numberedDeals = (catalog: Product[]) =>
  catalog
    .filter((product) => product.deal)
    .flatMap((product) => [product.name, ...product.aliases])
    .map((label) => normalizeCatalogText(label).split(' ').filter(Boolean))
    .filter((words) => words.some(isNumber));
// Words a deal's number goes with: "deal no 2", "ڈیل نمبر 2", "number 3 deal".
const NUMBER_SIGNS = new Set(['no', 'number', 'num', 'nmbr', 'nambar', 'نمبر']);
// A deal name's deal word may be written as another word only ever meaning deals ("deals 2 and
// 4", "ڈیل 2") or as its plural ("combos 2 and 3").
const writes = (token: string | undefined, word: string) =>
  token === word ||
  (DEAL_WORDS.has(word) && !!token && (ONLY_DEAL_WORDS.has(token) || token === `${word}s`));
// Where a deal name written from `at` in `tokens` ends, or -1. "No" or "number" may come between
// its deal word and its number ("deal no 2", "ڈیل نمبر 2").
function nameEnd(tokens: string[], at: number, label: string[]): number {
  let k = at;
  for (const [n, word] of label.entries()) {
    if (isNumber(word) && DEAL_WORDS.has(label[n - 1] ?? '') && NUMBER_SIGNS.has(tokens[k] ?? ''))
      k++;
    if (!writes(tokens[k], word)) return -1;
    k++;
  }
  return k;
}
const NUMBER_JOINERS = new Set(['and', 'aur', 'or', 'اور']);
// What may follow a number that names another deal: the end, "and", another number, a softener
// or a verb ("deal 2 aur 3 chahiye"). Any other word is what the number counts ("deal 2 aur 3
// zinger").
const endsNumber = (word: string | undefined) =>
  word === undefined ||
  NUMBER_JOINERS.has(word) ||
  isNumber(word) ||
  SOFTENERS.has(word) ||
  GIVE_VERBS.has(word) ||
  AFTER_COUNT.has(word);
/**
 * The bare numbers after a name ending in a number (`label`, written up to `end`) that each make
 * another name in its place, with "and" between them or not: the 3 in "deal 2 and 3" with a Deal
 * 3, the 2 and 3 in "deal 1, 2 aur 3". They name those, never count this one.
 */
function namedAfter(
  tokens: string[],
  label: string[],
  end: number,
  known: (name: string) => boolean,
  ends = (k: number) => endsNumber(tokens[k + 1]),
): { at: number; label: string }[] {
  const found: { at: number; label: string }[] = [];
  const own = label.at(-1);
  if (!isNumber(own)) return found;
  for (let k = end; k < tokens.length; k++) {
    if (NUMBER_JOINERS.has(tokens[k]!)) k++;
    const name = [...label.slice(0, -1), tokens[k]].join(' ');
    if (!isNumber(tokens[k]) || tokens[k] === own || !known(name) || !ends(k)) break;
    found.push({ at: k, label: name });
  }
  return found;
}
// Where in `tokens` a number belongs to such a deal name written in full: the 2 in "deal 2" and
// "deal no 2", and the 3 in "deal 2 and 3" with a Deal 3.
function namedNumbers(tokens: string[], labels: string[][]): Set<number> {
  const named = new Set<number>();
  const known = new Set(labels.map((label) => label.join(' ')));
  for (const label of labels)
    for (let at = 0; at < tokens.length; at++) {
      const end = nameEnd(tokens, at, label);
      if (end < 0) continue;
      for (let k = at; k < end; k++) if (isNumber(tokens[k])) named.add(k);
      for (const next of namedAfter(tokens, label, end, (name) => known.has(name)))
        named.add(next.at);
    }
  return named;
}

/** The first count in the text; a number inside a deal name of `catalog` ("deal 2") is not one. */
export function quantityFromText(text: string, catalog: Product[] = []): number {
  const value = normalizeCatalogText(text);
  const tokens = value.split(' ');
  const named = namedNumbers(tokens, numberedDeals(catalog));
  const numeric = tokens.find((token, i) => /^\d{1,2}$/.test(token) && !named.has(i));
  if (numeric) return Math.max(1, Math.min(50, Number(numeric)));
  for (let i = 0; i < tokens.length; i++)
    if (NUMBER_WORDS[tokens[i]!] && countsAsNumber(tokens, i)) return NUMBER_WORDS[tokens[i]!]!;
  return 1;
}

/**
 * The count of a deal ordered by a deal word alone ("2 deal chahiye", "do deals", "deal x2"):
 * right before the deal word, or after it with an x. A bare number after it, or beside "no" or
 * "number", may be the deal's own ("deal 7", "deal no 2", "2 number deal"), and a number
 * elsewhere is another detail ("deal bhej do, phase 5").
 */
export function dealWordCount(text: string): number {
  const tokens = normalizeCatalogText(text).split(' ');
  const i = tokens.findIndex((token) => DEAL_WORDS.has(token));
  if (i < 0) return 1;
  const before = tokens[i - 1] ?? '';
  const sign = tokens[i - 2] ?? '';
  const after = (tokens[i + 1] === 'x' ? `x${tokens[i + 2] ?? ''}` : (tokens[i + 1] ?? '')).match(
    /^x(\d{1,2})$|^(\d{1,2})x$/,
  );
  const count = /^\d{1,2}$/.test(before)
    ? NUMBER_SIGNS.has(sign) || ADDRESS_WORDS.has(sign)
      ? undefined
      : Number(before)
    : NUMBER_WORDS[before] && countsAsNumber(tokens, i - 1)
      ? NUMBER_WORDS[before]
      : undefined;
  return Math.max(1, Math.min(50, count ?? Number(after?.[1] ?? after?.[2] ?? 1)));
}

// Words that may sit between a count and the dish: "2 full karahi", "3 plate biryani".
const MEASURE_WORDS = new Set(
  'x plate plates glass glasses cup cups bowl bowls piece pieces pc pcs serving servings portion portions kg kilo packet packets box boxes'.split(
    ' ',
  ),
);
const sameWord = (input: string, label: string) => {
  if (input === label) return true;
  const limit = input.length >= 8 ? 2 : 1;
  return (
    input.length >= 4 &&
    label.length >= 4 &&
    Math.abs(input.length - label.length) <= limit &&
    editDistance(input, label) <= limit
  );
};
// Where one item's part of a message ends: punctuation, a new line, or a word joining two items
// ("naan 3, chicken wali", "naan 4\nchicken 1", "tikka 2 aur chicken wali"). A count belongs to
// the dish in its own part only.
export const CLAUSE_BREAK = /[,،;.۔|\n!?؟؛]+|(?<=^|\s)(?:aur|and|bhi|also|plus|or|&|اور)(?=\s|$)/iu;
const clausesOf = (text: string) =>
  text
    .split(CLAUSE_BREAK)
    .map((clause) => normalizeCatalogText(clause).split(' ').filter(Boolean))
    .filter((tokens) => tokens.length);
// "chicken wali 2", "tikka wala 3".
const WALA = new Set(
  'wala wali wale waala waali waale vala vali wla wli والا والی والے'.split(' '),
);
// What may follow a count written after the dish: a measure ("biryani 2 plate"), a softener or
// a verb ("biryani 2 de do", "naan 3 chahiye"). Anything else ("phase 5 mein", "2 baje tak")
// makes it a detail, not a count.
const AFTER_COUNT = new Set(
  'do dein den dena dijiye dijye chahiye chahye chaiye chahie chahiyen bhejo bhejein bhejen bhejna add karo kardo krdo karein karen kariye kijiye چاہیے چاہئے بھیجیں بھیجو دیں کریں'.split(
    ' ',
  ),
);
// Words an address number follows: "block 4 biryani" is not four biryanis.
const ADDRESS_WORDS = new Set(
  'house h hno plot street st gali lane road block blk phase sector sec flat floor apartment apt makan ghar mohalla number no num'.split(
    ' ',
  ),
);
// A part that is only a count ("biryani, 3", "biryani, make it 3 please").
const COUNT_ONLY = new Set(
  'make it them total only sirf bas qty quantity karo kar kardo krdo kr dein den chahiye chahye chaiye x'.split(
    ' ',
  ),
);
interface DishWords {
  own: string[];
  options: Set<string>;
  // Words naming the restaurant's other dishes.
  others: Set<string>;
  // The other dishes' option words ("half" in "karahi half 4 naan"), part of their mention,
  // also when this dish has the same option ("karahi half 4 biryani" with a half biryani).
  otherOptions: Set<string>;
  // Deal names with a number in them ("Deal 2"): that number is never a count, and "deal 2 and
  // 3" names Deal 3.
  numberedDeals: string[][];
  // A count as written ("100 naan", "1000 naan" are refused later), not kept within 1-50.
  exact?: boolean;
}
// A count in digits ("3", "3x", "x3"), or undefined.
function digitCount(token: string, words: DishWords): number | undefined {
  const digits = token.match(words.exact ? /^x?(\d{1,4})x?$/ : /^x?(\d{1,2})x?$/)?.[1];
  if (digits === undefined) return undefined;
  return words.exact ? Number(digits) : Math.max(1, Math.min(50, Number(digits)));
}
const labelWords = (product: Product) =>
  [product.name, ...product.aliases]
    .flatMap((label) => normalizeCatalogText(label).split(' '))
    .filter((token) => token && !STOP_WORDS.has(token));
const optionWords = (product: Product) =>
  product.variants.flatMap((option) => normalizeCatalogText(option.name).split(' '));
function dishWords(product: Product, catalog: Product[], exact = false): DishWords {
  const others = catalog.filter(
    (other) => other.id !== product.id && other.companyId === product.companyId,
  );
  const own = labelWords(product);
  const options = new Set(optionWords(product));
  return {
    own,
    options,
    others: new Set(others.flatMap(labelWords)),
    otherOptions: new Set(
      others.flatMap(optionWords).filter((word) => word && !own.includes(word)),
    ),
    numberedDeals: numberedDeals([product, ...others]),
    exact,
  };
}
// Where in `tokens` a number is part of a deal's name (see numberedDeals), for this catalog.
const namedIn = (tokens: string[], words: DishWords) =>
  words.numberedDeals.length ? namedNumbers(tokens, words.numberedDeals) : new Set<number>();
const isOwn = (words: DishWords, token: string) =>
  words.own.some((label) => sameWord(token, label));
// Where the dish is named: its part of the message, where its words are in it, and the next part.
interface Mention {
  tokens: string[];
  at: number;
  end: number;
  next?: string[];
}
function findMention(
  text: string,
  matchAt: (tokens: string[]) => { at: number; end: number } | undefined,
  split = true,
): Mention | undefined {
  const parts = split ? clausesOf(text) : [normalizeCatalogText(text).split(' ').filter(Boolean)];
  for (let index = 0; index < parts.length; index++) {
    const tokens = parts[index]!;
    const found = matchAt(tokens);
    if (found) return { tokens, ...found, next: parts[index + 1] };
  }
  return undefined;
}
// The first part of the message naming the dish, by any of its words.
const dishMention = (text: string, words: DishWords) =>
  findMention(text, (tokens) => {
    const at = tokens.findIndex((token) => isOwn(words, token));
    if (at < 0) return undefined;
    let end = at;
    while (end < tokens.length && isOwn(words, tokens[end]!)) end++;
    return { at, end };
  });
const isCount = (token: string, words: DishWords) =>
  digitCount(token, words) !== undefined || !!NUMBER_WORDS[token];
// Where another dish is named straight before index `i` (with its options, a measure or "wala"
// after its name: "karahi half 4", "chicken wali 4"), the index its words start at; else -1.
function otherDishBefore(tokens: string[], i: number, words: DishWords): number {
  const partOfMention = (token: string) =>
    words.otherOptions.has(token) || MEASURE_WORDS.has(token) || WALA.has(token);
  let k = i - 1;
  while (k >= 0 && partOfMention(tokens[k]!)) k--;
  if (k < 0 || !words.others.has(tokens[k]!) || isOwn(words, tokens[k]!)) return -1;
  while (
    k > 0 &&
    (words.others.has(tokens[k - 1]!) ||
      words.options.has(tokens[k - 1]!) ||
      partOfMention(tokens[k - 1]!))
  )
    k--;
  return k;
}
// Whether the count at `i` leads the dish after it. A count straight after another dish ends
// that dish's part ("naan 3 chicken wali"), unless that dish has a count of its own before it
// ("3 naan 2 chicken biryani"). So one number is never two dishes' count.
function countLeads(tokens: string[], i: number, words: DishWords): boolean {
  const start = otherDishBefore(tokens, i, words);
  if (start < 0) return true;
  const j = start - 1;
  return j >= 0 && isCount(tokens[j]!, words) && countLeads(tokens, j, words);
}
function countBefore({ tokens, at }: Mention, words: DishWords): number | undefined {
  let i = at - 1;
  while (i >= 0 && (words.options.has(tokens[i]!) || MEASURE_WORDS.has(tokens[i]!))) i--;
  if (i < 0) return undefined;
  const token = tokens[i]!;
  // "deal 2 deal 3": the 2 is Deal 2's name, not a count of Deal 3.
  if (namedIn(tokens, words).has(i)) return undefined;
  const count =
    digitCount(token, words) ?? (token === 'a' || token === 'an' ? undefined : NUMBER_WORDS[token]);
  if (count === undefined) return undefined;
  // "bhej do chicken wali": "do" straight after a verb is "give", not two.
  if ((token === 'do' || token === 'دو') && GIVE_VERBS.has(tokens[i - 1] ?? '')) return undefined;
  if (ADDRESS_WORDS.has(tokens[i - 1] ?? '')) return undefined;
  return countLeads(tokens, i, words) ? count : undefined;
}
// `clear`: only a count that can be no other dish's, so not one followed by another dish.
// `bare`: a bare number counts too ("biryani 3"); without it only "x3", "3x" or a number word.
function countAfter(
  { tokens, end, next }: Mention,
  words: DishWords,
  clear = false,
  bare = true,
): number | undefined {
  let i = end;
  while (
    i < tokens.length &&
    (isOwn(words, tokens[i]!) || words.options.has(tokens[i]!) || WALA.has(tokens[i]!))
  )
    i++;
  const x = tokens[i] === 'x';
  if (x) i++;
  const token = tokens[i];
  // Nothing after the dish: a next part that is only a count ("biryani, make it 3"). The number
  // of a name there is not one ("deal 2 aur deal 3" is one Deal 2), nor one naming the deal
  // after this one ("deal 2 and 3").
  if (token === undefined) {
    if (!bare) return undefined;
    const named = namedIn(next ?? [], words);
    const label = words.numberedDeals.find((l) =>
      tokens.some((_, at) => nameEnd(tokens, at, l) === tokens.length),
    );
    const known = new Set(words.numberedDeals.map((l) => l.join(' ')));
    if (label)
      for (const sibling of namedAfter([...tokens, ...(next ?? [])], label, tokens.length, (n) =>
        known.has(n),
      ))
        named.add(sibling.at - tokens.length);
    const counts = (next ?? []).filter(
      (word, k) =>
        !named.has(k) && !COUNT_ONLY.has(word) && !SOFTENERS.has(word) && !isOwn(words, word),
    );
    return counts.length === 1 ? digitCount(counts[0]!, words) : undefined;
  }
  if (namedIn(tokens, words).has(i)) return undefined;
  if (!bare && !x && /^\d+$/.test(token)) return undefined;
  const count =
    digitCount(token, words) ??
    (['a', 'an', 'do', 'دو'].includes(token) ? undefined : NUMBER_WORDS[token]);
  if (count === undefined) return undefined;
  const after = tokens[i + 1];
  return after === undefined ||
    MEASURE_WORDS.has(after) ||
    SOFTENERS.has(after) ||
    GIVE_VERBS.has(after) ||
    AFTER_COUNT.has(after) ||
    // "naan 3 chicken biryani": the count ends this dish's part, as in "naan 3, chicken biryani".
    // It may also be read as "naan, 3 chicken biryani", so it is not a clear count.
    (!clear && words.others.has(after) && !isOwn(words, after))
    ? count
    : undefined;
}
/**
 * The count written right before the chosen dish ("3 chicken biryani", "do chicken wali",
 * "2 full karahi"), or undefined. A number elsewhere is another item's count or a detail
 * ("chicken wali, aur 3 naan", "naan 3, chicken wali", "naan 3 chicken wali", "house 12"), and
 * "a"/"an" leave an earlier count as it was. `catalog` (the restaurant's dishes) tells another
 * dish's count apart from this one's.
 */
export function quantityBefore(
  product: Product,
  text: string,
  catalog: Product[] = [],
): number | undefined {
  const words = dishWords(product, catalog);
  const mention = dishMention(text, words);
  return mention && countBefore(mention, words);
}
/**
 * The count written right after the dish in its own part of the message ("biryani 2", "chicken
 * wali 3 de do", "biryani x2", "biryani, make it 3"), or undefined. A number followed by other
 * words ("biryani bhej do DHA phase 5", "biryani 8 baje tak") is a detail, not a count.
 */
export function quantityAfter(
  product: Product,
  text: string,
  catalog: Product[] = [],
): number | undefined {
  const words = dishWords(product, catalog);
  const mention = dishMention(text, words);
  return mention && countAfter(mention, words);
}
/** The count written next to the dish, before or after it, in its own part of the message. */
export const quantityNear = (product: Product, text: string, catalog: Product[] = []) =>
  quantityBefore(product, text, catalog) ?? quantityAfter(product, text, catalog);
/**
 * The count next to the dish that can be no other dish's: before it, or after it where its
 * part of the message ends or a measure, softener or verb follows ("chicken wali 3", "biryani
 * 2 de do"). In "chicken wali 4 naan" the 4 may be the naan's, so it is not the dish's here.
 */
export function clearQuantityNear(
  product: Product,
  text: string,
  catalog: Product[] = [],
): number | undefined {
  const words = dishWords(product, catalog);
  const mention = dishMention(text, words);
  return mention && (countBefore(mention, words) ?? countAfter(mention, words, true));
}
/**
 * For a deal, the count next to it that can be nothing else: before it ("2 deal 1"), or after it
 * with an x or in words ("deal 1 x2", "deal 1 teen"). A bare number after a deal may be another
 * deal's number ("deal 2 3"), so it is no such count.
 */
export function clearDealQuantity(
  product: Product,
  text: string,
  catalog: Product[] = [],
): number | undefined {
  const words = dishWords(product, catalog);
  const mention = dishMention(text, words);
  return mention && (countBefore(mention, words) ?? countAfter(mention, words, true, false));
}
/**
 * The count for one exact mention of a dish ("chicken tikka" in "2 chicken biryani aur 1
 * chicken tikka"), before it or else right after it in the mention's own part, as written.
 */
export function quantityOfMention(
  product: Product,
  alias: string,
  text: string,
  catalog: Product[] = [],
): number | undefined {
  const words = dishWords(product, catalog, true);
  const label = normalizeCatalogText(alias).split(' ').filter(Boolean);
  if (!label.length) return undefined;
  const matchAt = (tokens: string[]) => {
    for (let at = 0; at + label.length <= tokens.length; at++)
      if (label.every((word, k) => tokens[at + k] === word)) return { at, end: at + label.length };
    return undefined;
  };
  // A name that itself joins two words ("Fish and Chips") is read in the whole message.
  const mention = findMention(text, matchAt) ?? findMention(text, matchAt, false);
  return mention && (countBefore(mention, words) ?? countAfter(mention, words));
}
/**
 * Whether the text states this count anywhere, as digits or a word that can only be a count.
 * The number of a deal's name in `catalog` ("deal 2") is not a count.
 */
export function mentionsQuantity(text: string, quantity: number, catalog: Product[] = []): boolean {
  const tokens = normalizeCatalogText(text).split(' ');
  const named = namedNumbers(tokens, numberedDeals(catalog));
  return tokens.some(
    (token, i) =>
      !named.has(i) &&
      (token.replace(/^x(?=\d)|(?<=\d)x$/, '') === String(quantity) ||
        (!['a', 'an', 'do', 'دو'].includes(token) && NUMBER_WORDS[token] === quantity)),
  );
}

// The words of a text with where each one is written and which part of the message (see
// clausesOf) it is in. Joining words stay, as a name may hold one ("Fish and Chips").
interface Placed {
  word: string;
  start: number;
  end: number;
  part: number;
}
const CLAUSE_BREAKS = new RegExp(CLAUSE_BREAK.source, 'giu');
function placedWords(text: string): Placed[] {
  const breaks = [...text.matchAll(CLAUSE_BREAKS)].map((m) => m.index + m[0].length);
  const placed: Placed[] = [];
  for (const m of text.matchAll(/[\p{L}\p{M}\p{N}]+/gu)) {
    const start = m.index,
      end = start + m[0].length;
    const part = breaks.filter((at) => at <= start).length;
    for (const word of normalizeCatalogText(m[0]).split(' ').filter(Boolean))
      placed.push({ word, start, end, part });
  }
  return placed;
}
const isLeadingCount = (word: string | undefined) =>
  !!word &&
  (/^\d{1,2}$/.test(word) || (!!NUMBER_WORDS[word] && !['a', 'an', 'do', 'دو'].includes(word)));

export interface DealMention {
  /**
   * The deal; or the deals a deal word with a shared word could each mean ("lunch deal"), the
   * deals on offer of one name, or a deal and the dish it is named like.
   */
  products: Product[];
  /** The words that named it, as one phrase of the message ("deal 2", "zinger deal"). */
  phrase: string;
  /** Where that phrase starts in the text. */
  at: number;
  /** Option ids picked with it in its own part of the message ("deal 1 with sprite"). */
  picks: string[];
  /** Every stretch of the text about this deal: its name each time, and its picks. */
  spans: [number, number][];
  /** Its count, where only its number is written ("deal 2 and 3": one Deal 3). */
  quantity?: number;
}
/**
 * The deals a text names, in the order written. A deal is named only by one of its whole names
 * (digits included, no typos: "deal 12" is not Deal 1), or by a deal word together with another
 * word of its name in the same part of the message ("zinger deal" for Zinger Lunch Deal; "lunch
 * deal" may be several), its number with "no" or "number" beside it or not ("ڈیل 2", "deal no
 * 2", "number 3 deal"). A deal word next to another number is not a numbered deal ("lunch deal
 * 3" is not Lunch Deal 1). Paused and ended deals are found by their whole names only, so they
 * can be refused by name; a deal word alone never offers them, and a deal on offer or a dish of
 * the same name goes first. Two deals on offer of one name, or one named like a dish, are one
 * mention of both, to ask which. A deal's name inside a longer dish name written there ("zinger"
 * in "zinger burger") is that dish's. A bare number after a numbered name names the deal with
 * that number ("deal 2 and 3"). An option of the deal's choices named in the same part without a
 * count of its own is its pick ("deal 1 with sprite"; the longer name wins, "diet coke" over
 * "coke"), one per choice in order.
 */
export function findDealMentions(
  products: Product[],
  companyId: string,
  text: string,
): DealMention[] {
  const deals = products.filter((product) => product.companyId === companyId && product.deal);
  if (!deals.length) return [];
  const placed = placedWords(text);
  const words = placed.map((p) => p.word);
  const span = (from: number, to: number): [number, number] => [
    placed[from]!.start,
    placed[to - 1]!.end,
  ];
  const taken = new Set<number>();
  const free = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (taken.has(k)) return false;
    return true;
  };
  const mentions: (DealMention & { part: number })[] = [];
  const mentionOf = (product: Product) =>
    mentions.find((m) => m.products.length === 1 && m.products[0] === product);
  const gone = (product: Product) =>
    product.deal?.state === 'paused' || product.deal?.state === 'ended';
  // Where each whole name (or other name) of these products is written.
  const whereNamed = (list: Product[]) =>
    list.flatMap((product) =>
      [...new Set([product.name, ...product.aliases].map(normalizeCatalogText))]
        .filter(Boolean)
        .flatMap((label) => {
          const parts = label.split(' ');
          const found: { product: Product; from: number; to: number }[] = [];
          for (let at = 0; at + parts.length <= words.length; at++)
            if (parts.every((part, k) => words[at + k] === part))
              found.push({ product, from: at, to: at + parts.length });
          return found;
        }),
    );
  // The dishes' names written: a deal's name inside a longer one is that dish's ("zinger" in
  // "zinger burger"), and a deal named like a dish is asked about beside it.
  const dishAt = whereNamed(
    products.filter((product) => product.companyId === companyId && !product.deal),
  );
  // Each deal name, with its deals: those on offer first, then paused or ended ones.
  const dealsNamed = new Map<string, Product[]>();
  for (const product of [...deals].sort((a, b) => Number(gone(a)) - Number(gone(b))))
    for (const label of new Set([product.name, ...product.aliases].map(normalizeCatalogText)))
      if (label) dealsNamed.set(label, [...(dealsNamed.get(label) ?? []), product]);
  // "deal 2 and 3", "deal 1, 2 aur 3": the deals the numbers after a numbered name make, each
  // its own mention (a deal on offer over a paused or ended one of that name).
  const numberedAfter = (label: string[], end: number) => {
    const ends = (k: number) => placed[k + 1]?.part !== placed[k]!.part || endsNumber(words[k + 1]);
    for (const next of namedAfter(words, label, end, (name) => dealsNamed.has(name), ends)) {
      if (!free(next.at, next.at + 1)) break;
      taken.add(next.at);
      const all = dealsNamed.get(next.label)!;
      const on = all.filter((product) => !gone(product));
      mentions.push({
        products: on.length ? on : all.slice(0, 1),
        phrase: words[next.at]!,
        at: placed[next.at]!.start,
        picks: [],
        spans: [span(next.at, next.at + 1)],
        quantity: 1,
        part: placed[next.at]!.part,
      });
    }
  };
  // Whole names, longest first; of one name, a deal on offer before a paused or ended one.
  const named = whereNamed(deals).sort(
    (a, b) =>
      b.to - b.from - (a.to - a.from) ||
      a.from - b.from ||
      Number(gone(a.product)) - Number(gone(b.product)),
  );
  for (const { product, from, to } of named) {
    // Inside a longer dish name written there, the words are that dish's.
    if (dishAt.some((d) => d.from <= from && to <= d.to && d.to - d.from > to - from)) continue;
    const [start, end] = span(from, to);
    // Two deals of one name on offer: which one. A paused or ended one beside them is not meant.
    const same = mentions.find((m) => m.spans.some(([s, e]) => s === start && e === end));
    if (same) {
      if (!gone(product) && !gone(same.products[0]!))
        same.products.splice(same.products.filter((p) => p.deal).length, 0, product);
      continue;
    }
    if (!free(from, to)) continue;
    // A deal named like a dish: which one; a paused or ended deal leaves the words to the dish.
    const alike = dishAt.filter((d) => d.from === from && d.to === to).map((d) => d.product);
    if (alike.length && gone(product)) continue;
    for (let k = from; k < to; k++) taken.add(k);
    const known = alike.length ? undefined : mentionOf(product);
    if (known) known.spans.push([start, end]);
    else
      mentions.push({
        products: [product, ...alike],
        phrase: words.slice(from, to).join(' '),
        at: start,
        picks: [],
        spans: [[start, end]],
        part: placed[from]!.part,
      });
    numberedAfter(words.slice(from, to), to);
  }
  // A deal word with other words of one deal's name. One in a dish's name written there ("kids
  // meal", or "combo" for a Family Combo also called that) is that dish's.
  const offered = deals.filter((product) => !gone(product));
  for (let i = 0; i < words.length; i++) {
    if (taken.has(i) || !DEAL_WORDS.has(words[i]!)) continue;
    if (dishAt.some((d) => d.from <= i && i < d.to)) continue;
    const part = placed[i]!.part;
    const inPart = (k: number) => !taken.has(k) && placed[k]?.part === part;
    const numberAt = (k: number) => inPart(k) && isNumber(words[k]);
    const signAt = (k: number) => inPart(k) && NUMBER_SIGNS.has(words[k]!);
    // "deal no. 2": the number after a sign may follow its full stop.
    const signedAt = (k: number) =>
      numberAt(k) ||
      (!taken.has(k) &&
        isNumber(words[k]) &&
        /^\.\s*$/u.test(text.slice(placed[k - 1]!.end, placed[k]!.start)));
    // The number of a numbered deal: straight after the deal word, as a name written in other
    // letters ("ڈیل 1" for Deal 1), or with "no" or "number" beside it ("deal no 2", "number 3
    // deal", "2 number deal"). A number before the deal word otherwise is a count ("2 ڈیل 1").
    const [at, sign]: (number | undefined)[] = numberAt(i + 1)
      ? [i + 1]
      : signAt(i + 1) && signedAt(i + 2)
        ? [i + 2, i + 1]
        : signAt(i - 2) && numberAt(i - 1)
          ? [i - 1, i - 2]
          : signAt(i - 1) && numberAt(i - 2)
            ? [i - 2, i - 1]
            : [];
    const after = at === undefined ? undefined : words[at];
    const near = after ? [after] : [i - 1].filter(numberAt).map((k) => words[k]!);
    let best = 0;
    let winners: { product: Product; used: number[] }[] = [];
    for (const product of offered) {
      const labels = [product.name, ...product.aliases].flatMap((label) =>
        normalizeCatalogText(label).split(' ').filter(Boolean),
      );
      const numbers = labels.filter((word) => /^\d+$/.test(word));
      if (numbers.length && near.some((number) => !numbers.includes(number))) continue;
      const own = new Set(
        labels.filter(
          (word) => !DEAL_WORDS.has(word) && !STOP_WORDS.has(word) && !/^\d+$/.test(word),
        ),
      );
      const used = placed.flatMap((p, k) =>
        p.part === part && !taken.has(k) && own.has(p.word) ? [k] : [],
      );
      if (after && numbers.includes(after)) used.push(at!, ...(sign === undefined ? [] : [sign]));
      const score = new Set(used.map((k) => words[k])).size;
      if (!score || score < best) continue;
      if (score > best) winners = [];
      best = score;
      winners.push({ product, used });
    }
    if (!winners.length) continue;
    const used = [...new Set([i, ...winners.flatMap((winner) => winner.used)])].sort(
      (a, b) => a - b,
    );
    used.forEach((k) => taken.add(k));
    const spans = used.map((k) => span(k, k + 1));
    const known = winners.length === 1 ? mentionOf(winners[0]!.product) : undefined;
    if (known) known.spans.push(...spans);
    else
      mentions.push({
        products: winners.map((winner) => winner.product),
        phrase: words.slice(used[0], used.at(-1)! + 1).join(' '),
        at: placed[used[0]!]!.start,
        picks: [],
        spans,
        part,
      });
    // "deals 2 and 4", "deal no 2 aur 3": the number after the deal word, then the deals the next
    // numbers make.
    const numbered =
      winners.length === 1 && after && at! > i && used.includes(at!)
        ? [winners[0]!.product.name, ...winners[0]!.product.aliases]
            .map((label) => normalizeCatalogText(label).split(' '))
            .find((label) => label.at(-1) === after)
        : undefined;
    if (numbered) numberedAfter(numbered, at! + 1);
  }
  for (const mention of mentions) {
    if (mention.products.length !== 1) continue;
    const { choices } = mention.products[0]!.deal!;
    // Each option name where it is written in the deal's part, without a count of its own.
    const options = new Map<string, DealChoiceOption[][]>();
    choices.forEach((group, g) =>
      group.options.forEach((option) => {
        const name = normalizeCatalogText(option.name);
        if (!name) return;
        const byGroup = options.get(name) ?? choices.map(() => []);
        byGroup[g]!.push(option);
        options.set(name, byGroup);
      }),
    );
    const found: { name: string; from: number; to: number }[] = [];
    const inPart = (k: number) => !taken.has(k) && placed[k]?.part === mention.part;
    for (const name of options.keys()) {
      const parts = name.split(' ');
      for (let at = 0; at + parts.length <= words.length; at++) {
        if (!parts.every((part, k) => words[at + k] === part && inPart(at + k))) continue;
        const after = at + parts.length;
        if (
          (inPart(at - 1) && isLeadingCount(words[at - 1])) ||
          (inPart(after) && /^\d{1,2}$/.test(words[after]!))
        )
          continue;
        found.push({ name, from: at, to: after });
      }
    }
    const kept: typeof found = [];
    for (const f of found.sort((a, b) => b.to - b.from - (a.to - a.from) || a.from - b.from))
      if (!kept.some((o) => o.from < f.to && f.from < o.to)) kept.push(f);
    kept.sort((a, b) => a.from - b.from);
    const used = new Set<(typeof kept)[number]>();
    choices.forEach((_, g) => {
      const pick = kept.find((o) => !used.has(o) && options.get(o.name)![g]!.length);
      if (!pick) return;
      used.add(pick);
      mention.picks.push(options.get(pick.name)![g]![0]!.id);
    });
    for (const o of kept) {
      for (let k = o.from; k < o.to; k++) taken.add(k);
      mention.spans.push(span(o.from, o.to));
    }
  }
  return mentions.sort((a, b) => a.at - b.at).map(({ part: _part, ...mention }) => mention);
}

export type ItemResolution =
  | { kind: 'none'; quantity: number }
  | { kind: 'unique'; product: Product; quantity: number }
  | { kind: 'ambiguous'; products: Product[]; quantity: number };

export function resolveItemMention(
  products: Product[],
  companyId: string,
  text: string,
): ItemResolution {
  const value = normalizeCatalogText(text);
  const own = products.filter((product) => product.companyId === companyId);
  // Only a count next to the dish, never an address, area or time number elsewhere ("biryani
  // bhej do DHA phase 5", "biryani, house 12 street 4", "biryani 8 baje tak").
  const countFor = (candidates: Product[]) => {
    for (const product of candidates) {
      const count = quantityNear(product, text, own);
      if (count !== undefined) return count;
    }
    return 1;
  };
  // With no dish found the count is never used (the AI's prompt still shows it as before).
  const quantity = quantityFromText(value, own);
  const inputTokens = value.split(' ').filter(Boolean);
  if (!value || !own.length) return { kind: 'none', quantity };
  // Deals are found by their own names only (findDealMentions). They never join the family and
  // typo matching of dishes below, so "biryani" stays Chicken Biryani beside a Biryani Deal.
  const [deal] = findDealMentions(own, companyId, text);
  if (deal) {
    const count = Math.max(
      1,
      Math.min(
        50,
        deal.quantity ?? quantityOfMention(deal.products[0]!, deal.phrase, text, own) ?? 1,
      ),
    );
    return deal.products.length === 1
      ? { kind: 'unique', product: deal.products[0]!, quantity: count }
      : { kind: 'ambiguous', products: deal.products, quantity: count };
  }
  const dishes = own.filter((product) => !product.deal);
  if (!dishes.length) return { kind: 'none', quantity };
  const labelsById = new Map(
    dishes.map((product) => [
      product.id,
      [product.name, ...product.aliases].map(normalizeCatalogText).filter(Boolean),
    ]),
  );
  const tokenOwners = new Map<string, Set<string>>();
  for (const product of dishes)
    for (const label of labelsById.get(product.id)!) {
      for (const token of label.split(' ')) {
        if (!tokenOwners.has(token)) tokenOwners.set(token, new Set());
        tokenOwners.get(token)!.add(product.id);
      }
    }

  // A generic one-word family name (for example "lassi") must not silently select
  // a plain item when flavored products share the same term.
  const meaningful = inputTokens.filter((token) => !STOP_WORDS.has(token) && !/^\d+$/.test(token));
  for (const token of meaningful) {
    const family = dishes.filter((product) => tokenOwners.get(token)?.has(product.id));
    if (family.length > 1 && meaningful.length === 1)
      return { kind: 'ambiguous', products: family, quantity: countFor(family) };
  }

  const scored = dishes
    .map((product) => {
      let score = 0;
      const labels = labelsById.get(product.id)!;
      for (const label of labels) {
        const labelTokens = [...new Set(label.split(' '))];
        const sharedTerm = labelTokens.length === 1 && (tokenOwners.get(label)?.size ?? 0) > 1;
        if (containsPhrase(value, label) && !sharedTerm) {
          score = Math.max(score, 1000 + label.split(' ').length * 100 + label.length);
        }
        // Combine distinct word evidence. A shared "chicken" must not outweigh
        // "chicken biryyani" matching both words of Chicken Biryani.
        let labelScore = 0;
        for (const candidate of labelTokens) {
          let tokenScore = 0;
          for (const input of meaningful) {
            if (candidate === input) tokenScore = Math.max(tokenScore, 500);
            // "deal" is no typo of "daal", nor "deals" of anything; "combos" is still the plural
            // of a Family Combo's "combo".
            if (
              NO_TYPO_WORDS.has(input) &&
              (ONLY_DEAL_WORDS.has(input) ||
                candidate.replace(/s$/u, '') !== input.replace(/s$/u, ''))
            )
              continue;
            if (input.length < 4) continue;
            const limit = input.length >= 8 ? 2 : 1;
            if (candidate.length < 4 || Math.abs(candidate.length - input.length) > limit) continue;
            const distance = editDistance(input, candidate);
            if (distance <= limit) tokenScore = Math.max(tokenScore, 300 - distance * 20);
          }
          labelScore += tokenScore;
        }
        score = Math.max(score, labelScore);
      }
      return { product, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.product.name.localeCompare(b.product.name));
  if (!scored.length) return { kind: 'none', quantity };
  const best = scored[0]!.score;
  const winners = scored.filter((entry) => entry.score === best).map((entry) => entry.product);
  return winners.length === 1
    ? { kind: 'unique', product: winners[0]!, quantity: countFor(winners) }
    : { kind: 'ambiguous', products: winners, quantity: countFor(winners) };
}

export function resolvePendingItemChoice(
  products: Product[],
  companyId: string,
  pending: NonNullable<Conversation['pendingItemChoice']>,
  text: string,
): Product | undefined {
  // Ordinals refer to the displayed list, not repository/catalog ordering.
  const candidates = pending.candidateProductIds.map((id) =>
    products.find((product) => product.companyId === companyId && product.id === id),
  );
  const value = normalizeCatalogText(text);
  const ordinal = value.match(/^(?:option\s*)?(\d{1,2})$/)?.[1];
  // A number past the list may be the number on one listed deal's name: "10" for "4. Deal 10".
  if (ordinal) {
    if (Number(ordinal) <= candidates.length) return candidates[Number(ordinal) - 1];
    const named = candidates.filter(
      (p): p is Product =>
        !!p?.deal &&
        [p.name, ...p.aliases].some((label) =>
          normalizeCatalogText(label).split(' ').includes(ordinal),
        ),
    );
    return named.length === 1 ? named[0] : undefined;
  }
  const present = candidates.filter((p): p is Product => !!p);
  const resolution = resolveItemMention(present, companyId, text);
  if (resolution.kind !== 'none')
    return resolution.kind === 'unique' ? resolution.product : undefined;
  // The deals asked about are told apart by any other word of their names: "zinger" for Zinger
  // Lunch Deal, asked beside Biryani Lunch Deal.
  const said = new Set(value.split(' '));
  const deals = present.filter(
    (product) =>
      product.deal &&
      [product.name, ...product.aliases].some((label) =>
        normalizeCatalogText(label)
          .split(' ')
          .some(
            (word) =>
              said.has(word) &&
              !DEAL_WORDS.has(word) &&
              !STOP_WORDS.has(word) &&
              !/^\d+$/.test(word),
          ),
      ),
  );
  return deals.length === 1 ? deals[0] : undefined;
}
