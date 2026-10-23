import type { Company, Integration, Product } from '../../src/shared/types.js';
import type { Repository } from '../repository.js';
import { PublicError, decryptSecret, encryptSecret, logFailure } from '../security.js';
import { catalogRows } from './catalog.js';
import {
  DRIVE_FILE_SCOPE,
  GOOGLE_REAUTH,
  exchangeCode,
  googleAccessToken,
  googleAccount,
  googleReason,
  revokeGoogleToken,
} from './google-oauth.js';
import { GoogleSheetsAdapter, ORDER_HEADERS } from './sheets.js';

// "Connect with Google": from the popup's code to a tested Sheets connection, with a Sheet
// Orderly creates in the owner's Drive (or the one it made before, when that still opens).

/** The connection settings only this flow writes; a key file's connection never has them. */
export const GOOGLE_CONFIG_KEYS = ['auth', 'googleAccountId', 'googleEmail'] as const;

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

/** The refresh token stored for a business's Google connection, if it has one. */
async function storedToken(repo: Repository, companyId: string): Promise<string | undefined> {
  const integration = (await repo.getIntegrations(companyId)).find((i) => i.kind === 'sheets');
  const secret = await repo.getSecret(companyId, 'sheets');
  if (integration?.config.auth !== 'oauth' || !secret) return;
  try {
    return decryptSecret(secret);
  } catch {
    return;
  }
}

/**
 * A refresh token that still works for this Google account, kept by any business connected with
 * it. Google gives a refresh token only the first time an account allows Orderly, so a second
 * restaurant of the same owner, or a reconnect, reuses the one already given. Undefined only
 * when Google has ended every stored one: a token Google merely didn't answer for may still
 * work for its business, so then this throws and nothing is ended.
 */
async function workingTokenFor(repo: Repository, accountId: string): Promise<string | undefined> {
  let unanswered = false;
  for (const companyId of await repo.sheetsCompaniesForGoogleAccount(accountId)) {
    const token = await storedToken(repo, companyId);
    if (!token) continue;
    try {
      await googleAccessToken(token);
      return token;
    } catch (error) {
      if (!(error instanceof PublicError && error.code === GOOGLE_REAUTH)) unanswered = true;
    }
  }
  if (unanswered)
    throw new PublicError('Google didn’t answer Orderly. Try again in a minute.', 503);
}

/**
 * Ends Orderly's Google access for a business's connection, unless another business still uses
 * the same Google account: Google ends the whole grant, which would cut that one off too.
 * Best effort and never throws. True when nothing is left for the owner to remove by hand.
 */
export async function releaseGoogleAccess(
  repo: Repository,
  removed: { integration?: Integration; token?: string },
): Promise<boolean> {
  if (removed.integration?.config.auth !== 'oauth') return true;
  const accountId = removed.integration.config.googleAccountId;
  // Nothing Orderly can end: the owner removes it in their Google Account.
  if (!accountId || !removed.token) return false;
  try {
    if ((await repo.sheetsCompaniesForGoogleAccount(accountId)).length) return true;
    if (await revokeGoogleToken(removed.token)) return true;
    logFailure('google_revoke', {}, new Error('Google did not confirm the revoke.'));
    return false;
  } catch (error) {
    logFailure('google_revoke', {}, error);
    return false;
  }
}

/** What a disconnect, a key file or a deletion replaces, read before it is gone. */
export async function googleAccessOf(
  repo: Repository,
  companyId: string,
): Promise<{ integration?: Integration; token?: string }> {
  const integration = (await repo.getIntegrations(companyId)).find((i) => i.kind === 'sheets');
  if (integration?.config.auth !== 'oauth') return {};
  return { integration, token: await storedToken(repo, companyId) };
}

async function sheetsCall(accessToken: string, url: string, init: RequestInit = {}) {
  return fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
}

// A bold, frozen header row, then the values, all as typed (never read as formulas).
function tab(title: string, rows: (string | number)[][]) {
  return {
    properties: { title, gridProperties: { frozenRowCount: 1 } },
    data: [
      {
        startRow: 0,
        startColumn: 0,
        rowData: rows.map((row, index) => ({
          values: row.map((value) => ({
            userEnteredValue:
              typeof value === 'number' ? { numberValue: value } : { stringValue: value },
            ...(index === 0 && { userEnteredFormat: { textFormat: { bold: true } } }),
          })),
        })),
      },
    ],
  };
}

/**
 * Creates the order Sheet in the owner's Drive: an Orders tab with Orderly's column titles and,
 * when the menu is read from the Sheet, a Menu tab holding the current menu.
 */
async function createSheet(accessToken: string, company: Company, menu?: Product[]) {
  const response = await sheetsCall(accessToken, SHEETS, {
    method: 'POST',
    body: JSON.stringify({
      properties: {
        title: `Orderly – ${company.name} orders`,
        ...(company.timezone && { timeZone: company.timezone }),
      },
      sheets: [tab('Orders', [ORDER_HEADERS]), ...(menu ? [tab('Menu', catalogRows(menu))] : [])],
    }),
  });
  const body = (await response.json().catch(() => ({}))) as { spreadsheetId?: unknown };
  if (!response.ok || typeof body.spreadsheetId !== 'string') {
    const failure = new PublicError(
      'Google didn’t let Orderly create your Sheet. Try again in a minute.',
      502,
    );
    logFailure(
      'google_sheet_create',
      { status: response.status, reason: googleReason(body) },
      failure,
    );
    throw failure;
  }
  return body.spreadsheetId;
}

/** Whether the Sheet Orderly made before still opens with this sign-in. */
async function stillOpens(accessToken: string, spreadsheetId: string): Promise<boolean> {
  if (!/^[\w-]{15,150}$/.test(spreadsheetId)) return false;
  const response = await sheetsCall(
    accessToken,
    `${SHEETS}/${spreadsheetId}?fields=spreadsheetId`,
  ).catch(() => undefined);
  return !!response?.ok;
}

export interface GoogleSheetsConnected {
  integration: Integration;
  /** A new Sheet was made (not the one from an earlier connection). */
  created: boolean;
  title: string;
}

/**
 * Finishes "Connect with Google" for a business: the code from the owner's popup becomes a
 * stored refresh token, the Sheet is made (or the earlier one kept), and the connection is
 * tested. A failed test leaves the connection saved with its error, as the Test button does.
 */
export async function connectGoogleSheets(
  repo: Repository,
  company: Company,
  code: string,
): Promise<GoogleSheetsConnected> {
  const tokens = await exchangeCode(code);
  if (!tokens.scopes.includes(DRIVE_FILE_SCOPE))
    throw new PublicError(
      'Google didn’t give Orderly permission to make your Sheet. Click Connect with Google again and allow it.',
    );
  const account = await googleAccount(tokens.accessToken);
  const previous = await googleAccessOf(repo, company.id);
  const before = (await repo.getIntegrations(company.id)).find((i) => i.kind === 'sheets');
  let refreshToken: string | undefined;
  let created = false;
  let integration: Integration;
  try {
    refreshToken = tokens.refreshToken ?? (await workingTokenFor(repo, account.id));
    if (!refreshToken) {
      // Google gave no lasting access and Google has ended every one stored for this account, so
      // ending this sign-in touches nobody else, and the next shows Google's consent again.
      await revokeGoogleToken(tokens.accessToken);
      throw new PublicError(
        'Google didn’t give Orderly lasting access this time. Click Connect with Google once more.',
        409,
      );
    }
    const sameAccount =
      before?.config.auth === 'oauth' && before.config.googleAccountId === account.id;
    const kept =
      sameAccount &&
      !!before.config.spreadsheetId &&
      (await stillOpens(tokens.accessToken, before.config.spreadsheetId));
    const menu =
      company.catalogSource === 'sheets'
        ? (await repo.listProducts(company.id)).filter((p) => !p.deal)
        : undefined;
    created = !kept;
    const spreadsheetId = kept
      ? before.config.spreadsheetId
      : await createSheet(tokens.accessToken, company, menu?.length ? menu : undefined);
    integration = {
      kind: 'sheets',
      configured: true,
      status: 'configured',
      config: {
        auth: 'oauth',
        spreadsheetId,
        ordersSheet: (kept && before.config.ordersSheet) || 'Orders',
        catalogSheet: (kept && before.config.catalogSheet) || 'Menu',
        googleAccountId: account.id,
        ...(account.email && { googleEmail: account.email }),
      },
    };
    await repo.saveIntegration(company.id, integration, encryptSecret(refreshToken));
  } catch (error) {
    // A lasting sign-in Google gave just now and nothing kept: given back, unless another
    // business uses the account, so the next click gets Google's consent and a new one at once.
    if (
      tokens.refreshToken &&
      !(await repo.sheetsCompaniesForGoogleAccount(account.id).catch(() => ['unknown'])).length
    )
      await revokeGoogleToken(tokens.refreshToken);
    throw error;
  }
  // Another Google account's access, replaced just now.
  if (previous.integration && previous.integration.config.googleAccountId !== account.id)
    await releaseGoogleAccess(repo, previous);
  const title = `Orderly – ${company.name} orders`;
  const checkedAt = new Date().toISOString();
  try {
    await new GoogleSheetsAdapter(integration, refreshToken).test(
      company.catalogSource === 'sheets' ? { menuFor: company.id } : {},
    );
  } catch (error) {
    await repo.saveIntegration(company.id, {
      ...integration,
      status: 'error',
      error: error instanceof PublicError ? error.message : 'The Sheet could not be checked.',
      checkedAt,
    });
    throw error;
  }
  const connected: Integration = { ...integration, status: 'connected', checkedAt };
  await repo.saveIntegration(company.id, connected);
  return { integration: connected, created, title };
}

/**
 * Before a business starts reading its menu from its Sheet. A Sheet Orderly made with Google
 * gets a Menu tab holding the current menu when it has none; then the Sheet must pass the check
 * with its menu, so the switch never leaves chats without a menu.
 */
export async function prepareSheetMenu(repo: Repository, company: Company) {
  const integration = (await repo.getIntegrations(company.id)).find((i) => i.kind === 'sheets');
  const secret = await repo.getSecret(company.id, 'sheets');
  if (!integration?.configured || !secret)
    throw new PublicError('Connect Google Sheets in Integrations first.', 409);
  const credential = decryptSecret(secret);
  if (integration.config.auth === 'oauth')
    await addMenuTab(
      integration,
      credential,
      (await repo.listProducts(company.id)).filter((p) => !p.deal),
    );
  await new GoogleSheetsAdapter(integration, credential).test({ menuFor: company.id });
}
// Best effort: when anything here fails, the check after it says what is wrong.
async function addMenuTab(integration: Integration, refreshToken: string, menu: Product[]) {
  const id = integration.config.spreadsheetId;
  const name = integration.config.catalogSheet || 'Menu';
  if (!menu.length || !/^[\w-]{15,150}$/.test(id ?? '')) return;
  const accessToken = await googleAccessToken(refreshToken);
  const meta = await sheetsCall(accessToken, `${SHEETS}/${id}?fields=sheets.properties.title`);
  if (!meta.ok) return;
  const tabs = (
    ((await meta.json().catch(() => ({})))?.sheets ?? []) as {
      properties?: { title?: unknown };
    }[]
  ).map((t) =>
    String(t?.properties?.title ?? '')
      .trim()
      .toLowerCase(),
  );
  if (tabs.includes(name.trim().toLowerCase())) return;
  const added = await sheetsCall(accessToken, `${SHEETS}/${id}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({
      requests: [
        { addSheet: { properties: { title: name, gridProperties: { frozenRowCount: 1 } } } },
      ],
    }),
  });
  if (!added.ok) return;
  const range = encodeURIComponent(`'${name.replace(/'/g, "''")}'!A1`);
  await sheetsCall(accessToken, `${SHEETS}/${id}/values/${range}?valueInputOption=RAW`, {
    method: 'PUT',
    body: JSON.stringify({ values: catalogRows(menu) }),
  });
}
