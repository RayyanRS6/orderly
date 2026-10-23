// Connecting Google Sheets as a restaurant owner: the step-by-step form reads the Sheet's link
// and the key file Google downloads, and says which step is still missing. The tests run
// without a browser, so they check the helpers and what the form renders on the server.
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { supportEmail } from '../src/components/Public';
import {
  SheetsConnect,
  sheetsConfigForSave,
  sheetsFormProblem,
} from '../src/components/SheetsConnect';
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
      error: expect.stringContaining('OAuth client file'),
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

describe('saving the Sheets form', () => {
  const ready = { spreadsheetId: id, clientEmail: email };

  it('points at the step still to do', () => {
    expect(sheetsFormProblem({ clientEmail: email }, pem, false)).toContain('step 2');
    expect(sheetsFormProblem({ spreadsheetId: id }, pem, false)).toContain('step 4');
    expect(sheetsFormProblem(ready, '', false)).toContain('step 4');
    expect(sheetsFormProblem(ready, '{"web":{}}', false)).toContain('isn’t a Google key file');
  });

  it('saves with a new key, or with the key already saved', () => {
    expect(sheetsFormProblem(ready, pem, false)).toBeUndefined();
    expect(sheetsFormProblem(ready, '', true)).toBeUndefined();
  });

  it('saves tab names without stray spaces, which syncing would not ignore', () => {
    expect(
      sheetsConfigForSave({ ...ready, catalogSheet: ' Menu ', ordersSheet: 'My Orders ' }),
    ).toEqual({ ...ready, catalogSheet: 'Menu', ordersSheet: 'My Orders' });
  });
});

describe('the Sheets connect form', () => {
  const render = (config: Record<string, string>, keySaved = false, secret = '') =>
    renderToStaticMarkup(
      createElement(SheetsConnect, {
        config: { catalogSheet: 'Menu', ordersSheet: 'Orders', ...config },
        onConfig: () => {},
        secret,
        onSecret: () => {},
        keySaved,
      }),
    );

  it('walks a new owner through six steps, with Google’s pages opening in new tabs', () => {
    const html = render({});
    for (const title of [
      'Make your Google Sheet',
      'Paste the Sheet’s link',
      'Get a key file from Google',
      'Upload the key file',
      'Share your Sheet with the helper account',
      'Save and test',
    ])
      expect(html).toContain(title);
    for (const href of [
      'https://sheets.new',
      'https://console.cloud.google.com/projectcreate',
      'https://console.cloud.google.com/flows/enableapi?apiid=sheets.googleapis.com',
      'https://console.cloud.google.com/projectselector/iam-admin/serviceaccounts/create',
      'https://console.cloud.google.com/iam-admin/serviceaccounts',
    ])
      expect(html).toContain(`href="${href}" target="_blank" rel="noopener noreferrer"`);
    expect(html).toContain('href="/examples/menu.csv"');
    // Google blocks key files on some new accounts: the owner is sent to support.
    expect(html).toContain('Service account key creation is disabled');
    expect(html).toContain(`href="mailto:${supportEmail}"`);
    // No email to share with until the key file is read.
    expect(html).toContain('shows here after step 4');
    expect(html).not.toContain('aria-label="Helper account email"');
  });

  it('shows the email to share with, and the connected Sheet’s link, once known', () => {
    const html = render({ spreadsheetId: id, clientEmail: email }, true);
    expect(html).toContain(`value="${email}"`);
    expect(html).toContain(`value="${sheetUrl(id)}"`);
    expect(html).toContain('Sheet found.');
    expect(html).toContain('A key is already saved.');
  });

  it('confirms a key file read in this visit', () => {
    const html = render({ spreadsheetId: id, clientEmail: email }, false, pem);
    expect(html).toContain('Key file read.');
  });
});
