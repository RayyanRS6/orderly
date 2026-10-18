import type { Bootstrap, Company } from '../shared/types';
import { ApiError } from './api';

// Saving a business's settings (PUT /api/companies/:id). Each save sends the settingsRevision
// its copy of the settings was read with; the server refuses an older copy (STALE_SETTINGS)
// instead of undoing a newer change, and answers a save with the saved company and its new
// revision, which the workspace takes over so the next save in the same visit is current.

/** The server's code for a save made from an older copy of the settings. */
export const STALE_SETTINGS = 'STALE_SETTINGS';
/** A save refused because the settings changed in another tab or by another person. */
export const isStaleSettings = (e: unknown): e is ApiError =>
  e instanceof ApiError && e.code === STALE_SETTINGS;
/** The label of the action that loads the latest settings after a refused save. */
export const RELOAD_SETTINGS = 'Reload settings';
/**
 * Shown when an older copy asked to pause automation: the server always lets a pause through,
 * and then saves nothing else from that copy.
 */
export const PAUSED_ONLY =
  'Automatic replies are paused. Nothing else was saved, because the settings changed in another tab or by another person. Reload to see the latest settings.';

/** The saved company in a mutate result, when the request was a settings save for `companyId`. */
export function savedCompany(
  path: string,
  method: string | undefined,
  result: unknown,
  companyId: string | undefined,
): Company | undefined {
  if (!companyId || method !== 'PUT' || path !== `/companies/${companyId}`) return;
  const saved = result as Partial<Company> | null;
  return saved && typeof saved === 'object' && saved.id === companyId && !!saved.name
    ? (saved as Company)
    : undefined;
}
/** The workspace with the saved company (and its new revision) in place of the one on screen. */
export function adoptSavedCompany(data: Bootstrap, saved: Company): Bootstrap {
  if (data.company.id !== saved.id) return data;
  return {
    ...data,
    company: saved,
    companies: data.companies.map((c) => (c.id === saved.id ? saved : c)),
  };
}
/**
 * True when the server applied only a pause from an older copy. A normal save stores the
 * revision it was sent plus one; a pause from an older copy stores the newer revision plus one.
 */
export function pausedOnly(body: unknown, saved: Pick<Company, 'settingsRevision'>): boolean {
  const sent = (body as { settingsRevision?: unknown } | null)?.settingsRevision;
  return (
    typeof sent === 'number' &&
    typeof saved.settingsRevision === 'number' &&
    saved.settingsRevision !== sent + 1
  );
}
