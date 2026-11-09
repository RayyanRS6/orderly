// Reading what an owner pastes or uploads when connecting Google Sheets: the Sheet's link (or
// its bare ID) and the service account key file Google downloads. The server still checks
// both; these only turn what the owner has in hand into the fields it expects.

/** The spreadsheet ID rule the server checks (server/integrations/sheets.ts). */
const SPREADSHEET_ID = /^[\w-]{15,150}$/;

/** The address of a spreadsheet, for showing which Sheet is connected. */
export const sheetUrl = (id: string) => `https://docs.google.com/spreadsheets/d/${id}/edit`;

/**
 * A "Publish to the web" link (…/spreadsheets/d/e/2PACX-…). It names a published copy, not
 * the spreadsheet, and its key is not the ID the Sheets API needs.
 */
export const isPublishedSheetLink = (input: string) => /\/spreadsheets\/d\/e\//.test(input);

/** The spreadsheet ID in a Google Sheets link, or the ID itself; undefined when there is none. */
export function spreadsheetIdFrom(input: string): string | undefined {
  const text = input.trim();
  if (SPREADSHEET_ID.test(text)) return text;
  if (isPublishedSheetLink(text)) return;
  const id = /\/spreadsheets\/(?:u\/\d+\/)?d\/([\w-]+)/.exec(text)?.[1];
  return id && SPREADSHEET_ID.test(id) ? id : undefined;
}

/** What a pasted Sheet link holds, in words for the owner; undefined while the box is empty. */
export function sheetLinkProblem(input: string): string | undefined {
  if (!input.trim() || spreadsheetIdFrom(input)) return;
  if (isPublishedSheetLink(input))
    return 'This is a “Publish to the web” link. Open the Sheet itself and copy the link from the address bar at the top of the browser.';
  if (/docs\.google\.com\/(document|presentation|forms)\//.test(input))
    return 'This link is to a Google Doc, Slides or Form. Paste the link of a Google Sheet.';
  return 'This doesn’t look like a Google Sheet link. Open your Sheet and copy the whole link from the address bar at the top of the browser.';
}

export interface ServiceAccountKey {
  clientEmail: string;
  privateKey: string;
}

/** The largest key file read: Google's are about 2.4 KB. */
export const KEY_FILE_LIMIT = 20_000;

const NOT_A_KEY =
  'This isn’t the key file. Choose the newest file Google downloaded. Its long name usually starts with orderly.';

/**
 * The email and private key in a downloaded service account key file (its JSON text), or why
 * the text is not one.
 */
export function serviceAccountKeyFrom(text: string): ServiceAccountKey | { error: string } {
  let key: unknown;
  try {
    key = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return { error: NOT_A_KEY };
  }
  if (!key || typeof key !== 'object' || Array.isArray(key)) return { error: NOT_A_KEY };
  const fields = key as Record<string, unknown>;
  // An OAuth client's file (credentials.json) holds "installed" or "web", and no key.
  if ('installed' in fields || 'web' in fields)
    return {
      error:
        'This is a different kind of Google file. Make the key from your helper’s Keys page: Add key, Create new key, JSON.',
    };
  const { client_email: clientEmail, private_key: privateKey } = fields;
  if (
    fields.type !== 'service_account' ||
    typeof clientEmail !== 'string' ||
    !clientEmail.includes('@') ||
    typeof privateKey !== 'string' ||
    !privateKey.includes('PRIVATE KEY')
  )
    return { error: NOT_A_KEY };
  return { clientEmail: clientEmail.trim(), privateKey };
}

/** True when pasted text is a whole key file rather than the private key alone. */
export const looksLikeKeyFile = (text: string) => text.trim().startsWith('{');
