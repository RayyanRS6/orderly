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
/**
 * The count written right before the chosen dish ("3 chicken biryani", "do chicken wali",
 * "2 full karahi"), or undefined. A number elsewhere is another item's count or a detail
 * ("chicken wali, aur 3 naan", "house 12"), and "a"/"an" leave an earlier count as it was.
 */
export function quantityBefore(product: Product, text: string): number | undefined {
  const tokens = normalizeCatalogText(text).split(' ').filter(Boolean);
  const labels = [product.name, ...product.aliases]
    .flatMap((label) => normalizeCatalogText(label).split(' '))
    .filter((token) => token && !STOP_WORDS.has(token));
  const options = new Set(
    product.variants.flatMap((option) => normalizeCatalogText(option.name).split(' ')),
  );
  const at = tokens.findIndex((token) => labels.some((label) => sameWord(token, label)));
  let i = at - 1;
  while (i >= 0 && (options.has(tokens[i]!) || MEASURE_WORDS.has(tokens[i]!))) i--;
  if (at < 1 || i < 0) return undefined;
  const digits = tokens[i]!.match(/^(\d{1,2})x?$/)?.[1];
  if (digits) return Math.max(1, Math.min(50, Number(digits)));
  return tokens[i] === 'a' || tokens[i] === 'an' ? undefined : NUMBER_WORDS[tokens[i]!];
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
  const quantity = quantityFromText(value);
  const own = products.filter((product) => product.companyId === companyId);
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
      return { kind: 'ambiguous', products: family, quantity };
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
    ? { kind: 'unique', product: winners[0]!, quantity }
    : { kind: 'ambiguous', products: winners, quantity };
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
