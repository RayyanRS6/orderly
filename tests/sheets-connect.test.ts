// Connecting Google Sheets as a restaurant owner: reading the Sheet's link and the key file Google
// downloads. The guide around them is in tests/sheets-guide.test.ts.
import { describe, expect, it } from 'vitest';
import {
  looksLikeKeyFile,
  serviceAccountKeyFrom,
  sheetLinkProblem,
  sheetUrl,
  spreadsheetIdFrom,
} from '../src/lib/sheets-connect';

const id = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';
const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQ\n-----END PRIVATE KEY-----\n';
const email = 'orderly@orderly-123456.iam.gserviceaccount.com';
const keyFile = (fields: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'service_account',
    project_id: 'orderly-123456',
    private_key_id: 'abc',
    private_key: pem,
    client_email: email,
    client_id: '1',
    ...fields,
  });

describe('the Sheet link', () => {
  it('finds the spreadsheet ID in the links people copy, or takes the ID itself', () => {
    for (const link of [
      `https://docs.google.com/spreadsheets/d/${id}/edit?gid=0#gid=0`,
      `https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`,
      `https://docs.google.com/spreadsheets/d/${id}/edit?usp=sharing`,
      `https://docs.google.com/spreadsheets/u/0/d/${id}/edit`,
      `docs.google.com/spreadsheets/d/${id}`,
      `  ${id}  `,
    ])
      expect(spreadsheetIdFrom(link)).toBe(id);
  });

  it('refuses links without a spreadsheet ID, and says what to copy instead', () => {
    const published = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSabcdefghijklmnop/pubhtml';
    expect(spreadsheetIdFrom(published)).toBeUndefined();
    expect(sheetLinkProblem(published)).toContain('Publish to the web');
    const doc = `https://docs.google.com/document/d/${id}/edit`;
    expect(spreadsheetIdFrom(doc)).toBeUndefined();
    expect(sheetLinkProblem(doc)).toContain('Google Doc');
    expect(spreadsheetIdFrom('my sheet')).toBeUndefined();
    expect(sheetLinkProblem('my sheet')).toContain('address bar');
  });

  it('says nothing while the box is empty or the link is good', () => {
    expect(sheetLinkProblem('')).toBeUndefined();
    expect(sheetLinkProblem(sheetUrl(id))).toBeUndefined();
  });
});

describe('the key file', () => {
  it('reads the email and private key from a downloaded service account key', () => {
    expect(serviceAccountKeyFrom(keyFile())).toEqual({ clientEmail: email, privateKey: pem });
    // Saved by an editor that adds a byte order mark.
    expect(serviceAccountKeyFrom(`﻿${keyFile()}`)).toMatchObject({ clientEmail: email });
  });

  it('tells an OAuth client file apart from a service account key', () => {
    const oauth = JSON.stringify({ installed: { client_id: 'x', client_secret: 'y' } });
    expect(serviceAccountKeyFrom(oauth)).toEqual({
      error: expect.stringContaining('different kind of Google file'),
    });
  });

  it('refuses anything else as not the key file', () => {
    for (const text of [
      'not json',
      '[]',
      'null',
      keyFile({ type: 'authorized_user' }),
      keyFile({ private_key: 'secret' }),
      keyFile({ client_email: undefined }),
    ])
      expect(serviceAccountKeyFrom(text)).toEqual({
        error: expect.stringContaining('isn’t the key file'),
      });
  });

  it('knows a pasted key file from a pasted private key', () => {
    expect(looksLikeKeyFile(` ${keyFile()}`)).toBe(true);
    expect(looksLikeKeyFile(pem)).toBe(false);
  });
});
