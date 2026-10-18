/** Every business slug: lowercase letters and digits in groups joined by single hyphens. */
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The readable start of a business slug, from its name. Accents are dropped ('Café' → 'cafe')
 * and any other run of characters becomes one hyphen, with none left at either end. A name
 * with no Latin letters or digits (an Urdu name, say) becomes 'business'. The caller adds a
 * unique suffix, so the result always matches SLUG_RE.
 */
export function slugify(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 70)
    .replace(/^-+|-+$/g, '');
  return base || 'business';
}
