import type { Conversation, Product } from '../shared/types';

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

export function quantityFromText(text: string): number {
  const value = normalizeCatalogText(text);
  const numeric = value.match(/(?:^|\s)(\d{1,2})(?:\s|$)/)?.[1];
  if (numeric) return Math.max(1, Math.min(50, Number(numeric)));
  const tokens = value.split(' ');
  for (let i = 0; i < tokens.length; i++)
    if (NUMBER_WORDS[tokens[i]!] && countsAsNumber(tokens, i)) return NUMBER_WORDS[tokens[i]!]!;
  return 1;
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
const CLAUSE_BREAK = /[,،;.۔|\n!?؟؛]+|(?<=^|\s)(?:aur|and|bhi|also|plus|or|&|اور)(?=\s|$)/iu;
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
  // A count as written ("100 naan" is refused later), not kept within 1-50.
  exact?: boolean;
}
// A count in digits ("3", "3x", "x3"), or undefined.
function digitCount(token: string, words: DishWords): number | undefined {
  const digits = token.match(words.exact ? /^x?(\d{1,3})x?$/ : /^x?(\d{1,2})x?$/)?.[1];
  if (digits === undefined) return undefined;
  return words.exact ? Number(digits) : Math.max(1, Math.min(50, Number(digits)));
}
const labelWords = (product: Product) =>
  [product.name, ...product.aliases]
    .flatMap((label) => normalizeCatalogText(label).split(' '))
    .filter((token) => token && !STOP_WORDS.has(token));
function dishWords(product: Product, catalog: Product[], exact = false): DishWords {
  return {
    own: labelWords(product),
    options: new Set(
      product.variants.flatMap((option) => normalizeCatalogText(option.name).split(' ')),
    ),
    others: new Set(
      catalog
        .filter((other) => other.id !== product.id && other.companyId === product.companyId)
        .flatMap(labelWords),
    ),
    exact,
  };
}
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
function countBefore({ tokens, at }: Mention, words: DishWords): number | undefined {
  let i = at - 1;
  while (i >= 0 && (words.options.has(tokens[i]!) || MEASURE_WORDS.has(tokens[i]!))) i--;
  if (i < 0) return undefined;
  const token = tokens[i]!;
  const count =
    digitCount(token, words) ?? (token === 'a' || token === 'an' ? undefined : NUMBER_WORDS[token]);
  if (count === undefined) return undefined;
  // "bhej do chicken wali": "do" straight after a verb is "give", not two.
  if ((token === 'do' || token === 'دو') && GIVE_VERBS.has(tokens[i - 1] ?? '')) return undefined;
  if (ADDRESS_WORDS.has(tokens[i - 1] ?? '')) return undefined;
  // "naan 3 chicken wali": a count straight after another dish is that dish's, unless that dish
  // has its own count before it ("3 naan 2 chicken biryani").
  if (i > 0 && words.others.has(tokens[i - 1]!) && !isOwn(words, tokens[i - 1]!)) {
    let j = i - 1;
    while (
      j >= 0 &&
      (words.others.has(tokens[j]!) ||
        words.options.has(tokens[j]!) ||
        MEASURE_WORDS.has(tokens[j]!) ||
        WALA.has(tokens[j]!))
    )
      j--;
    if (j < 0 || !isCount(tokens[j]!, words)) return undefined;
  }
  return count;
}
function countAfter({ tokens, end, next }: Mention, words: DishWords): number | undefined {
  let i = end;
  while (
    i < tokens.length &&
    (isOwn(words, tokens[i]!) || words.options.has(tokens[i]!) || WALA.has(tokens[i]!))
  )
    i++;
  if (tokens[i] === 'x') i++;
  const token = tokens[i];
  // Nothing after the dish: a next part that is only a count ("biryani, make it 3").
  if (token === undefined) {
    const counts = (next ?? []).filter(
      (word) => !COUNT_ONLY.has(word) && !SOFTENERS.has(word) && !isOwn(words, word),
    );
    return counts.length === 1 ? digitCount(counts[0]!, words) : undefined;
  }
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
    (words.others.has(after) && !isOwn(words, after))
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
/** Whether the text states this count anywhere, as digits or a word that can only be a count. */
export function mentionsQuantity(text: string, quantity: number): boolean {
  return normalizeCatalogText(text)
    .split(' ')
    .some(
      (token) =>
        token.replace(/^x(?=\d)|(?<=\d)x$/, '') === String(quantity) ||
        (!['a', 'an', 'do', 'دو'].includes(token) && NUMBER_WORDS[token] === quantity),
    );
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
  const quantity = quantityFromText(value);
  const inputTokens = value.split(' ').filter(Boolean);
  if (!value || !own.length) return { kind: 'none', quantity };
  const labelsById = new Map(
    own.map((product) => [
      product.id,
      [product.name, ...product.aliases].map(normalizeCatalogText).filter(Boolean),
    ]),
  );
  const tokenOwners = new Map<string, Set<string>>();
  for (const product of own)
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
    const family = own.filter((product) => tokenOwners.get(token)?.has(product.id));
    if (family.length > 1 && meaningful.length === 1)
      return { kind: 'ambiguous', products: family, quantity: countFor(family) };
  }

  const scored = own
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
  if (ordinal) return candidates[Number(ordinal) - 1];
  const resolution = resolveItemMention(
    candidates.filter((p): p is Product => !!p),
    companyId,
    text,
  );
  return resolution.kind === 'unique' ? resolution.product : undefined;
}
