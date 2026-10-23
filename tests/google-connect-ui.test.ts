// "Connect with Google" in the Sheets dialog: when it warns about an app's built-in browser, how
// Google's popup endings read, and what the section shows before and after connecting. The
// tests run without a browser, so they check the helpers and the server-rendered markup.
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  GoogleSheetsConnect,
  connectedText,
  type GoogleSheetsConnected,
} from '../src/components/GoogleSheetsConnect';
import { KeyFileOption } from '../src/components/SheetsConnect';
import { codeErrorText, inAppBrowser, popupErrorText } from '../src/lib/google-connect';
import { sheetUrl } from '../src/lib/sheets-connect';
import { Workspace, type WorkspaceContext } from '../src/lib/workspace';
import type { Integration } from '../src/shared/types';

describe('built-in browsers, where Google refuses to sign in', () => {
  it.each([
    [
      'Facebook',
      'Mozilla/5.0 (Linux; Android 14; SM-A146B Build/UP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.81 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/483.0.0.48.80;]',
    ],
    [
      'Messenger',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/MessengerForiOS;FBAV/470.0.0.40.108]',
    ],
    [
      'Instagram',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0.25.81',
    ],
    [
      'another app',
      'Mozilla/5.0 (Linux; Android 13; Redmi Note 12; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.6613.146 Mobile Safari/537.36',
    ],
    [
      'another app',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
    ],
  ])('names %s', (app, userAgent) => {
    expect(inAppBrowser(userAgent)).toBe(app);
  });

  it.each([
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0.6668.69 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  ])('lets a normal browser connect: %s', (userAgent) => {
    expect(inAppBrowser(userAgent)).toBeUndefined();
  });
});

describe('when Google’s window ends without a code', () => {
  it('says what happened and that nothing changed', () => {
    expect(popupErrorText('popup_failed_to_open')).toContain('Allow pop-ups for this site');
    expect(popupErrorText('popup_closed')).toContain('Nothing was changed');
    expect(popupErrorText('something_new')).toContain('Try again');
    expect(codeErrorText('access_denied')).toBe('You didn’t allow Orderly. Nothing was changed.');
    expect(codeErrorText('server_error')).toContain('Try again');
  });

  it('tells where the new Sheet is, or that the old one is kept', () => {
    const result = {
      created: true,
      title: 'Orderly – Dastarkhwan orders',
    } as GoogleSheetsConnected;
    expect(connectedText(result)).toContain(
      '“Orderly – Dastarkhwan orders” is in your Google Drive',
    );
    expect(connectedText({ ...result, created: false })).toContain('keeps using your Sheet');
  });
});

describe('the Connect with Google section', () => {
  const workspace = { mutate: async () => ({}) } as unknown as WorkspaceContext;
  const render = (integration?: Integration) =>
    renderToStaticMarkup(
      createElement(
        Workspace.Provider,
        { value: workspace },
        createElement(GoogleSheetsConnect, {
          clientId: 'client-id',
          integration,
          onConnected: () => {},
        }),
      ),
    );
  const google = (config: Record<string, string> = {}, error?: string): Integration => ({
    kind: 'sheets',
    configured: true,
    status: 'connected',
    ...(error && { error }),
    config: { auth: 'oauth', spreadsheetId: 'made_by_orderly_123456', ...config },
  });

  it('offers one click to a business without a Sheet', () => {
    const html = render();
    expect(html).toContain('Connect with Google (about a minute)');
    expect(html).toContain('Orderly can only open the files it makes.');
    // Until Google's library has loaded, the button says so (a click then does nothing).
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Loading Google…');
    expect(html).not.toContain('connected with a key file');
  });

  it('says a key-file connection is kept as it is', () => {
    const html = render({ kind: 'sheets', configured: true, status: 'connected', config: {} });
    expect(html).toContain('You’re connected with a key file now.');
  });

  it('shows the account and the Sheet once connected, and offers to reconnect', () => {
    const html = render(google({ googleEmail: 'owner@example.com' }));
    expect(html).toContain('Connected with Google as owner@example.com');
    expect(html).toContain(`href="${sheetUrl('made_by_orderly_123456')}"`);
    // Reconnecting is a quiet button here (it reads Reconnect Google once Google has loaded).
    expect(html).not.toContain('btn-primary');
  });

  it('puts the reconnect first when Google has ended the access', () => {
    const html = render(google({}, 'Click Reconnect Google in Integrations → Google Sheets.'));
    expect(html).toContain('Connected with Google');
    expect(html).toContain('Click Reconnect Google in Integrations');
    expect(html).toContain('btn-primary');
  });
});

describe('the key-file steps under Connect with Google', () => {
  const render = (collapsed: boolean, open: boolean) =>
    renderToStaticMarkup(
      createElement(KeyFileOption, {
        collapsed,
        open,
        children: createElement('form', null, 'steps'),
      }),
    );

  it('fold away, open for a business already on a key file', () => {
    expect(render(true, false)).toContain('Or use your own Google Cloud key file');
    expect(render(true, false)).not.toMatch(/<details[^>]* open/);
    expect(render(true, true)).toMatch(/<details[^>]* open/);
  });

  it('stay as they are when Connect with Google isn’t offered', () => {
    expect(render(false, false)).toBe('<form>steps</form>');
  });
});
