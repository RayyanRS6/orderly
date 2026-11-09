// The Google Sheets connect guide: one small screen at a time, and every failure Google can give
// opens the screen that fixes it. The tests run without a browser, so they check the guide's data,
// how it moves, and what each screen renders on the server.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { KeyFileOption, SheetsGuide, sheetsConfigForSave } from '../src/components/SheetsGuide';
import {
  FIX_FOR,
  MAIN_PATH,
  SCREENS,
  type GuideFacts,
  type ScreenId,
  clearProgress,
  fillIn,
  fixFor,
  helpEmail,
  loadProgress,
  nextScreen,
  resumable,
  saveProgress,
  startScreen,
} from '../src/lib/sheets-guide';
import { Workspace, type WorkspaceContext } from '../src/lib/workspace';
import {
  SHEETS_PROBLEMS,
  isLastingSheetsProblem,
  isPassingSheetsProblem,
  projectOfHelper,
} from '../src/shared/sheets-problems';
import type { Integration } from '../src/shared/types';

const email = 'friesnbuns@friesuns.iam.gserviceaccount.com';
const id = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';
const facts: GuideFacts = {
  project: 'friesuns',
  spreadsheetId: id,
  email,
  ordersTab: 'Orders',
  menuTab: 'Menu',
  ctrl: 'Ctrl',
  page: 'https://orderly.example/app/x/integrations',
};
const ids = Object.keys(SCREENS) as ScreenId[];
const allWords = (screen: (typeof SCREENS)[ScreenId]) => [
  screen.title,
  screen.what ?? '',
  ...(screen.steps ?? []),
  screen.see ?? '',
  ...(screen.stuck ?? []).flatMap((s) => [s.q, s.a]),
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the guideâ€™s words', () => {
  it.each(ids)('%s fills in every word and link', (screenId) => {
    const screen = SCREENS[screenId];
    for (const text of allWords(screen)) expect(fillIn(text, facts)).not.toMatch(/[{}]/);
    if (screen.open) {
      expect(screen.open.url.startsWith('https://')).toBe(true);
      expect(fillIn(screen.open.url, facts)).not.toMatch(/[{}]/);
    }
  });

  it.each(ids)('%s gives the owner something to do', (screenId) => {
    const screen = SCREENS[screenId];
    expect(screen.title.length).toBeLessThan(45);
    expect(!!screen.steps?.length || !!screen.choices || !!screen.what).toBe(true);
    // One small thing per screen: a long list is what loses an owner on Google's page.
    expect(screen.steps?.length ?? 0).toBeLessThanOrEqual(6);
  });

  it('never shows an owner the technical words', () => {
    const banned = /\bAPI key\b|\bOAuth\b|\bJWT\b|\b403\b|\bPEM\b|\btoken\b|\bscope\b/i;
    for (const screenId of ids)
      for (const text of allWords(SCREENS[screenId]))
        expect(text, `${screenId}: ${text}`).not.toMatch(banned);
  });

  it('points every way out at a screen that exists', () => {
    for (const screenId of ids) {
      const screen = SCREENS[screenId];
      for (const target of [
        screen.next,
        screen.also?.screen,
        ...(screen.choices ?? []).map((c) => c.screen),
        ...(screen.stuck ?? []).map((s) => s.go?.screen),
      ])
        if (target) expect(ids, `${screenId} â†’ ${target}`).toContain(target);
    }
  });

  it('opens the very page that fixed a real ownerâ€™s connection', () => {
    expect(fillIn(SCREENS['fix-api-off'].open!.url, facts)).toBe(
      'https://console.cloud.google.com/apis/library/sheets.googleapis.com?project=friesuns',
    );
    // Before a key file names the project, the link still opens the page.
    expect(fillIn(SCREENS['turn-on-sheets'].open!.url, { ...facts, project: '' })).toBe(
      'https://console.cloud.google.com/apis/library/sheets.googleapis.com',
    );
  });

  it('reads the project from the helperâ€™s email', () => {
    expect(projectOfHelper(email)).toBe('friesuns');
    expect(projectOfHelper('someone@gmail.com')).toBeUndefined();
    expect(projectOfHelper('')).toBeUndefined();
  });
});

describe('every failure has a fix', () => {
  it.each(SHEETS_PROBLEMS)('%s opens a screen', (code) => {
    expect(ids).toContain(FIX_FOR[code]);
    expect(fixFor(code)).toBe(FIX_FOR[code]);
  });

  it('asks for help for anything the server didnâ€™t name', () => {
    expect(fixFor(undefined)).toBe('fix-unknown');
    expect(fixFor('SOMETHING_NEW')).toBe('fix-unknown');
  });

  it('records only what the owner must fix', () => {
    for (const code of ['KEY_NOT_READY', 'GOOGLE_BUSY', 'GOOGLE_DOWN']) {
      expect(isPassingSheetsProblem(code)).toBe(true);
      expect(isLastingSheetsProblem(code)).toBe(false);
    }
    expect(isLastingSheetsProblem('SHEETS_API_OFF')).toBe(true);
    expect(isLastingSheetsProblem('SOMETHING_NEW')).toBe(false);
    expect(isLastingSheetsProblem(undefined)).toBe(false);
  });
});

describe('moving through the guide', () => {
  const at = (from: ScreenId, keySaved = false, fixing = false) =>
    nextScreen(from, { keySaved, fixing });

  it('goes through the main path in order, then to the check', () => {
    expect(at('intro')).toBe(MAIN_PATH[0]);
    for (let i = 0; i < MAIN_PATH.length - 1; i++) expect(at(MAIN_PATH[i]!)).toBe(MAIN_PATH[i + 1]);
    expect(at('share-send')).toBe('check');
  });

  it('asks for the key file before the switch, so the switch opens the right folder', () => {
    expect(MAIN_PATH.indexOf('upload-key')).toBeLessThan(MAIN_PATH.indexOf('turn-on-sheets'));
  });

  it('skips the Google Cloud steps for a new Sheet once a key is saved', () => {
    expect(at('copy-link', true)).toBe('share-open');
    expect(at('copy-link', false)).toBe('open-cloud');
  });

  it('goes back to the check after replacing a key in a fix', () => {
    expect(at('fix-new-key', true, true)).toBe('make-key');
    expect(at('make-key', true, true)).toBe('upload-key');
    expect(at('upload-key', true, true)).toBe('check');
  });

  it('starts at the fix for a named problem, the saved step, or the beginning', () => {
    const none = { keyConnection: false };
    expect(startScreen(none)).toBe('intro');
    expect(startScreen({ ...none, saved: 'make-key' })).toBe('make-key');
    expect(startScreen({ ...none, saved: 'gone-screen' })).toBe('intro');
    expect(startScreen({ ...none, problem: 'SHEETS_API_OFF' })).toBe('fix-api-off');
    const key = { keyConnection: true };
    expect(startScreen({ ...key, status: 'connected' })).toBe('connected');
    expect(startScreen({ ...key, status: 'configured' })).toBe('check');
    expect(startScreen({ ...key, status: 'connected', errorCode: 'SHEET_NOT_SHARED' })).toBe(
      'fix-not-shared',
    );
    // A problem named now wins over the step saved earlier.
    expect(startScreen({ ...key, problem: 'KEY_REJECTED', saved: 'share-open' })).toBe(
      'fix-new-key',
    );
  });

  it('never reopens on a screen with no way on', () => {
    // A help or fix screen saved by an older version opens the start instead of trapping the owner.
    for (const saved of ['get-help', 'fix-wrong-account', 'fix-key-blocked', 'connected'])
      expect(startScreen({ keyConnection: false, saved })).toBe('intro');
    expect(startScreen({ keyConnection: true, saved: 'get-help' })).toBe('check');
    for (const step of MAIN_PATH) expect(resumable(step)).toBe(true);
    expect(resumable('check')).toBe(true);
    for (const screen of ['intro', 'get-help', 'fix-api-off', 'connected', 'delete-key'])
      expect(resumable(screen)).toBe(false);
  });

  it('remembers the step and link, and survives a browser that stores nothing', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    });
    saveProgress('c1', { screen: 'make-key', link: 'https://x' });
    expect(loadProgress('c1')).toEqual({ screen: 'make-key', link: 'https://x' });
    expect(loadProgress('c2')).toBeUndefined();
    clearProgress('c1');
    expect(loadProgress('c1')).toBeUndefined();
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    expect(loadProgress('c1')).toBeUndefined();
    expect(() => saveProgress('c1', { screen: 'intro' })).not.toThrow();
    expect(() => clearProgress('c1')).not.toThrow();
  });

  it('writes the help email with the step and problem, and no key file', () => {
    const link = helpEmail({
      to: 'help@example.com',
      business: 'Fries & Buns',
      screenTitle: 'Turn on one Google switch',
      problem: 'SHEETS_API_OFF',
    });
    expect(link.startsWith('mailto:help@example.com?subject=')).toBe(true);
    const body = decodeURIComponent(link.split('body=')[1]!);
    expect(body).toContain('Business: Fries & Buns');
    expect(body).toContain('Step: Turn on one Google switch');
    expect(body).toContain('Problem code: SHEETS_API_OFF');
  });

  it('sends the log reference of an unexpected failure, and no made-up code', () => {
    const link = helpEmail({
      to: 'help@example.com',
      business: 'Fries & Buns',
      screenTitle: 'Something went wrong',
      problem: 'UNKNOWN',
      message: 'Something went wrong. Reference: abc123',
    });
    const body = decodeURIComponent(link.split('body=')[1]!);
    expect(body).not.toContain('Problem code');
    expect(body).toContain('Orderly said: Something went wrong. Reference: abc123');
  });
});

describe('what the guide shows', () => {
  const workspace = {
    data: { company: { id: 'company-1', name: 'Fries & Buns' } },
    refresh: async () => {},
  } as unknown as WorkspaceContext;
  const keyRow = (over: Partial<Integration> = {}): Integration => ({
    kind: 'sheets',
    configured: true,
    status: 'connected',
    config: { spreadsheetId: id, clientEmail: email, ordersSheet: 'Orders', catalogSheet: 'Menu' },
    ...over,
  });
  const render = (props: Partial<Parameters<typeof SheetsGuide>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(
        Workspace.Provider,
        { value: workspace },
        createElement(SheetsGuide, { onClose: () => {}, ...props }),
      ),
    );
  // A step comes back from saved progress; a help or fix screen isn't kept, so it is opened.
  const atStep = (screen: ScreenId) => {
    vi.stubGlobal('localStorage', {
      getItem: () => JSON.stringify({ screen }),
      setItem: () => {},
      removeItem: () => {},
    });
    return render(resumable(screen) ? {} : { start: screen });
  };

  it('starts with what this is, one screen only', () => {
    const html = render();
    expect(html).toContain('Before you start');
    expect(html).toContain('>Start<');
    expect(html).not.toContain('Make your new Sheet');
    expect(html).toContain('Any questions?');
  });

  it('shows where the owner is on the way through', () => {
    const html = atStep('make-sheet');
    expect(html).toContain(`Step 3 of ${MAIN_PATH.length}`);
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('Open a new Sheet');
    expect(html).toContain('href="https://sheets.new" target="_blank" rel="noopener noreferrer"');
    expect(html).toContain('I did it, next step');
    expect(html).toContain('You should now see');
  });

  it('wonâ€™t move on from the link or key file screens until there is one', () => {
    for (const screen of ['copy-link', 'upload-key'] as const)
      expect(atStep(screen)).toMatch(/<button[^>]*disabled[^>]*>[^<]*I did it/);
  });

  it('opens the exact fix for what the Test button found', () => {
    const html = render({ integration: keyRow(), problem: 'SHEETS_API_OFF' });
    expect(html).toContain('Turn on one Google switch');
    expect(html).toContain('which Google shows as friesuns');
    expect(html).toContain(
      'href="https://console.cloud.google.com/apis/library/sheets.googleapis.com?project=friesuns"',
    );
    expect(html).toContain('Check again');
    expect(html).not.toContain('Step ');
  });

  it('shows the email and the Sheet for a missing share', () => {
    const html = render({ integration: keyRow(), problem: 'SHEET_NOT_SHARED' });
    expect(html).toContain(`value="${email}"`);
    expect(html).toContain(`href="https://docs.google.com/spreadsheets/d/${id}/edit"`);
    expect(html).toContain('>Copy<');
  });

  it('opens the fix a background failure recorded on the connection', () => {
    const html = render({ integration: keyRow({ errorCode: 'SHEET_IS_EXCEL', error: 'Excel' }) });
    expect(html).toContain('This is an Excel file');
  });

  it('shows Orderlyâ€™s exact words about a menu row', () => {
    const html = render({
      integration: keyRow(),
      problem: 'MENU_INVALID',
      problemMessage: 'Row 7, price: â€œabcâ€ is not a price.',
    });
    expect(html).toContain('Fix one thing in your menu');
    expect(html).toContain('Row 7, price: â€œabcâ€ is not a price.');
  });

  it('sends the key file block to a person, not to Googleâ€™s admin settings', () => {
    const html = atStep('fix-key-blocked');
    expect(html).toContain('It is not your mistake');
    expect(html).toContain('Ask Orderly for help');
    expect(html).not.toContain('Override parent');
  });

  it('offers a real way to reach a person', () => {
    const html = atStep('get-help');
    expect(html).toContain('Email Orderly');
    expect(html).toContain('href="mailto:');
    expect(html).toContain('Never send your key file');
  });

  it('shows a connected Sheet and the way to change it', () => {
    const html = render({ integration: keyRow() });
    expect(html).toContain('Your Sheet is connected');
    expect(html).toContain('Change my Sheet or key file');
    expect(html).toContain('>Finish');
  });

  it('starts a Sheet connected with Google from the beginning, not its key-file fixes', () => {
    const html = render({
      integration: keyRow({ config: { auth: 'oauth', spreadsheetId: id } }),
    });
    expect(html).toContain('Before you start');
  });

  it('ignores a problem code left behind without its message', () => {
    const html = render({ integration: keyRow({ errorCode: 'SHEET_IS_EXCEL' }) });
    expect(html).not.toContain('This is an Excel file');
    expect(html).toContain('Your Sheet is connected');
  });

  it('fixes the connected Sheet, not a link left from an unfinished guide', () => {
    const other =
      'https://docs.google.com/spreadsheets/d/1OtherSheetOtherSheetOtherSheetOther/edit';
    vi.stubGlobal('localStorage', {
      getItem: () => JSON.stringify({ screen: 'copy-link', link: other }),
      setItem: () => {},
      removeItem: () => {},
    });
    const html = render({
      integration: keyRow({ config: { auth: 'oauth', spreadsheetId: id, ordersSheet: 'Orders' } }),
      problem: 'ORDERS_TAB_MISSING',
    });
    expect(html).toContain(`/spreadsheets/d/${id}/`);
    expect(html).not.toContain('1OtherSheet');
  });

  it('wants a new key file before checking a broken one again', () => {
    const html = render({ integration: keyRow(), problem: 'KEY_BROKEN' });
    expect(html).toMatch(/<button[^>]*disabled[^>]*>.*Check again/);
    expect(html).not.toContain('A key is already saved');
  });

  it('announces checks from one status region that is there from the start', () => {
    const html = render({ integration: keyRow(), problem: 'SHEETS_API_OFF' });
    expect(html.match(/role="status"/g)).toHaveLength(1);
    expect(html).toContain('<p class="sr-only" role="status"></p>');
  });
});

describe('saving and folding', () => {
  it('saves tab names and the email without stray spaces', () => {
    expect(
      sheetsConfigForSave({
        spreadsheetId: id,
        clientEmail: ` ${email} `,
        catalogSheet: ' Menu ',
        ordersSheet: 'My Orders ',
      }),
    ).toEqual({
      spreadsheetId: id,
      clientEmail: email,
      catalogSheet: 'Menu',
      ordersSheet: 'My Orders',
    });
  });

  it('folds the key-file guide under Connect with Google only when that is offered', () => {
    const render = (collapsed: boolean) =>
      renderToStaticMarkup(
        createElement(KeyFileOption, { collapsed, open: false, children: 'guide' }),
      );
    expect(render(true)).toContain('Or use your own Google key file');
    expect(render(false)).toBe('guide');
  });
});
