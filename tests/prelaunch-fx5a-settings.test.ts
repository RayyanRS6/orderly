// FX-5a (1): every dashboard settings save sends the settingsRevision its copy was read with and
// takes over the saved company, so a second save in the same visit works. A save from an older
// copy shows the server's words with "Reload settings". The dashboard's own API client is
// answered by the local demo server: no network, no AI provider.
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../server/app';
import { api, ApiError } from '../src/lib/api';
import {
  adoptSavedCompany,
  isStaleSettings,
  PAUSED_ONLY,
  pausedOnly,
  RELOAD_SETTINGS,
  savedCompany,
  STALE_SETTINGS,
} from '../src/lib/settings';
import { draftFrom, settingsSaveBody } from '../src/components/Settings';
import { ToastItem } from '../src/components/ui';
import type { Bootstrap, Company } from '../src/shared/types';
import { company, demoApp } from './helpers/demo-app';

const { generate } = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: generate,
  Output: { object: vi.fn() },
}));

const app = demoApp();
const repo = () => app.repo();
const source = (file: string) => readFileSync(join(process.cwd(), file), 'utf8');
const path = `/companies/${company.id}`;
const STALE_MESSAGE =
  'Settings changed in another tab or by another person. Reload to see the latest settings.';
const limits = {
  repliesPerHour: 400,
  repliesPerCustomerPerHour: 20,
  messagesPerCustomerPerMinute: 30,
};

// The dashboard's API client, answered by the local server. Anything else (the AI provider's
// key check) gets an empty answer.
function serve() {
  vi.stubEnv('VITE_API_BASE_URL', '');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) =>
      String(url).startsWith('/api/')
        ? createApp(repo()).request(`http://127.0.0.1:4000${url}`, init)
        : new Response('{"data":[]}', { status: 200 }),
    ),
  );
}
const bootstrap = () => api<Bootstrap>('/bootstrap', company.id);
const put = (body: unknown) => api<Company>(path, company.id, body, 'PUT');
const stored = async () => (await repo().getCompany(company.id))!;
// What mutate does with a settings save's answer.
function afterSave(data: Bootstrap, body: unknown, result: unknown) {
  const saved = savedCompany(path, 'PUT', result, company.id);
  expect(saved).toBeDefined();
  expect(pausedOnly(body, saved!)).toBe(false);
  return adoptSavedCompany(data, saved!);
}

describe('FX-5a: settings saves from the dashboard', () => {
  it('saves twice in one visit, from Settings and then Bot settings, with no reload between', async () => {
    serve();
    await repo().saveCompany({ ...company, botEnabled: false });
    let data = await bootstrap();
    // Settings: the form's copy, with the revision it was read with.
    const first = settingsSaveBody({ ...draftFrom(data.company), name: 'First save' });
    expect(first.settingsRevision).toBe(0);
    expect(first).not.toHaveProperty('aiLimits');
    const one = await put(first);
    data = afterSave(data, first, one);
    expect(data.company).toMatchObject({ name: 'First save', settingsRevision: 1 });
    expect(data.companies.find((c) => c.id === company.id)?.name).toBe('First save');
    // The form now shows what was saved, so its next save is current too.
    const second = settingsSaveBody({ ...draftFrom(one), phone: '+92 300 2222222' });
    expect(second.settingsRevision).toBe(1);
    data = afterSave(data, second, await put(second));
    // Bot settings saves from the workspace's company, even when the reload after the last
    // save failed: the saved company was taken over from the answer.
    const third = { ...data.company, aiLimits: limits };
    await expect(put(third)).resolves.toMatchObject({ settingsRevision: 3, aiLimits: limits });
    expect(await stored()).toMatchObject({
      name: 'First save',
      phone: '+92 300 2222222',
      aiLimits: limits,
      settingsRevision: 3,
    });
    // Sending the first copy again, as the form did before, is refused.
    await expect(put(first)).rejects.toMatchObject({ status: 409, code: STALE_SETTINGS });
  });

  it('shows the server’s words with Reload settings for a save from an older copy', async () => {
    serve();
    await repo().saveCompany({ ...company, botEnabled: false });
    const data = await bootstrap();
    // Another tab saves first.
    await put(settingsSaveBody({ ...draftFrom(data.company), name: 'Other tab' }));
    const error = await put(settingsSaveBody({ ...draftFrom(data.company), phone: '+92 1' })).catch(
      (e: unknown) => e,
    );
    expect(isStaleSettings(error)).toBe(true);
    expect((error as ApiError).message).toBe(STALE_MESSAGE);
    expect(await stored()).toMatchObject({ name: 'Other tab', phone: company.phone });
    const html = renderToStaticMarkup(
      createElement(ToastItem, {
        toast: {
          id: 1,
          message: (error as ApiError).message,
          tone: 'error',
          action: { label: RELOAD_SETTINGS, run: () => {} },
        },
        onDismiss: () => {},
      }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain(STALE_MESSAGE);
    expect(html).toMatch(/<button[^>]*class="btn mt-2"[^>]*>Reload settings<\/button>/);
    expect(html).toContain('aria-label="Dismiss notification"');
    // Reloaded, the same change saves.
    const reloaded = await bootstrap();
    await expect(
      put(settingsSaveBody({ ...draftFrom(reloaded.company), phone: '+92 1' })),
    ).resolves.toMatchObject({ name: 'Other tab', phone: '+92 1' });
    // Other refusals are not taken for an older copy.
    expect(isStaleSettings(new ApiError('Paused.', 409, { error: 'Paused.' }))).toBe(false);
    expect(isStaleSettings(new Error(STALE_MESSAGE))).toBe(false);
  });

  it('says so when an older copy got only its pause saved', async () => {
    serve();
    await repo().saveCompany({ ...company, botEnabled: true });
    let data = await bootstrap();
    data = afterSave(data, data.company, await put({ ...data.company, name: 'Newer name' }));
    // A copy from before that save pauses: the server saves the pause and nothing else.
    const old = { ...data.company, settingsRevision: 0, botEnabled: false, name: 'Old name' };
    const paused = await put(old);
    expect(paused).toMatchObject({ botEnabled: false, name: 'Newer name', settingsRevision: 2 });
    expect(pausedOnly(old, paused)).toBe(true);
    expect(PAUSED_ONLY).toBe(
      'Automatic replies are paused. Nothing else was saved, because the settings changed in another tab or by another person. Reload to see the latest settings.',
    );
    // A current copy, or one without a revision (a server from before it), is a normal save.
    expect(pausedOnly({ settingsRevision: 2 }, { settingsRevision: 3 })).toBe(false);
    expect(pausedOnly({ name: 'x' }, { settingsRevision: 3 })).toBe(false);
    expect(pausedOnly({ settingsRevision: 2 }, {})).toBe(false);
  });

  it('saves after Connect and test once the workspace has reloaded', async () => {
    serve();
    await repo().saveCompany({ ...company, botEnabled: false });
    generate.mockResolvedValue({
      output: { actions: [{ type: 'menu' }], response: { text: 'Menu.', askFor: 'none' } },
      usage: { inputTokens: 900, outputTokens: 40 },
    });
    const before = await bootstrap();
    await api('/ai/connect', company.id, {
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
      apiKey: 'sk-ant-business-test-key-0001',
      approve: true,
      attest: { noTrainingOptIn: true },
    });
    // The page's copy from before is now older.
    await expect(put(before.company)).rejects.toMatchObject({ code: STALE_SETTINGS });
    // mutate reloads the workspace after every change, Connect and test included.
    const after = await bootstrap();
    expect(after.company.settingsRevision).toBe(1);
    await expect(put({ ...after.company, aiLimits: limits })).resolves.toMatchObject({
      settingsRevision: 2,
      ai: { provider: 'anthropic', model: 'claude-haiku-5-5' },
    });
    const bot = source('src/components/BotSettings.tsx');
    expect(bot).toMatch(/await mutate\(\s*'\/ai\/connect',/);
    expect(source('src/App.tsx')).toMatch(
      /const saved = savedCompany\(path, method, result, data\?\.company\.id\);[\s\S]*?try \{\s*await refresh\(\);/,
    );
  });

  it('takes over only a settings save’s answer for the open business', () => {
    const data = { company, companies: [company] } as Bootstrap;
    const saved = { ...company, name: 'Saved', settingsRevision: 4 };
    expect(savedCompany(path, 'PUT', saved, company.id)).toBe(saved);
    expect(savedCompany(path, 'POST', saved, company.id)).toBeUndefined();
    expect(savedCompany('/companies', 'PUT', saved, company.id)).toBeUndefined();
    expect(savedCompany(path, 'PUT', { ok: true }, company.id)).toBeUndefined();
    expect(savedCompany(path, 'PUT', { ...saved, id: 'other' }, company.id)).toBeUndefined();
    expect(adoptSavedCompany(data, saved).company).toBe(saved);
    expect(adoptSavedCompany(data, { ...saved, id: 'other' })).toBe(data);
  });

  it('sends the revision from every settings save on the page, and reloads in place', () => {
    // Bot settings: pause or enable, limits and Turn AI off all send the workspace's company,
    // which carries its settingsRevision.
    const bot = source('src/components/BotSettings.tsx');
    expect(
      bot.match(/`\/companies\/\$\{data\.company\.id\}`,\s*\{\s*\.\.\.data\.company,/g),
    ).toHaveLength(3);
    const app = source('src/App.tsx');
    expect(app).toMatch(
      /const reloadAction: ToastAction = \{\s*label: RELOAD_SETTINGS,\s*busyLabel: 'Reloading…',\s*run: reloadSettings,\s*\};/,
    );
    expect(app).toContain("notify(message, 'error', stale ? reloadAction : undefined);");
    expect(app).toContain("notify(PAUSED_ONLY, 'info', reloadAction);");
    expect(app).toMatch(
      /const reloadSettings = useCallback\(async \(\) => \{\s*try \{\s*await refresh\(\);[\s\S]*?setSettingsReloads\(\(n\) => n \+ 1\);/,
    );
    expect(app).not.toMatch(/reloadSettings[\s\S]{0,400}location\.reload/);
    const settings = source('src/components/Settings.tsx');
    // After a save the form holds the saved company (and its revision), or keeps edits typed
    // meanwhile on top of the new revision; a pause-only answer leaves it unsaved.
    expect(settings).toMatch(
      /if \(company && pausedOnly\(body, company\)\) return;[\s\S]*?if \(company\) setDraft\(draftFrom\(company\)\);[\s\S]*?settingsRevision: company\.settingsRevision/,
    );
    // The Settings form starts again from the reloaded settings.
    expect(settings).toMatch(
      /reloads\.current = settingsReloads;[\s\S]*?setDraft\(draftFrom\(data\.company\)\);/,
    );
  });
});
