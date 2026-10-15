import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createApp } from '../server/app';
import { MemoryRepository } from '../server/repository';
import { defaultBot, normalizeBotConfig, sameBotConfig } from '../src/shared/bot';
import { seedCompanies } from '../src/shared/seed';
import type { BotSettings } from '../src/shared/types';
import { ActionButton, ToastItem } from '../src/components/ui';

const company = seedCompanies[0]!;

describe('comparing bot settings', () => {
  const draft = normalizeBotConfig({
    ...defaultBot,
    goal: 'Take orders',
    knowledge: [{ question: 'Parking?', answer: 'Behind the restaurant.' }],
  });

  it('treats settings the database returned with reordered keys as unchanged', () => {
    // PostgreSQL jsonb stores object keys in its own order.
    const fromDatabase = JSON.parse(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(draft)
            .reverse()
            .map(([key, value]) => [
              key,
              Array.isArray(value)
                ? value.map((item) =>
                    Object.fromEntries(Object.entries(item as object).reverse()),
                  )
                : value,
            ]),
        ),
      ),
    );
    expect(JSON.stringify(fromDatabase)).not.toBe(JSON.stringify(draft));
    expect(sameBotConfig(draft, fromDatabase)).toBe(true);
  });

  it('ignores spaces the server trims and fields that only older drafts have', () => {
    expect(sameBotConfig({ ...draft, goal: ' Take orders ' }, draft)).toBe(true);
    expect(sameBotConfig({ ...draft, steps: ['old'] }, draft)).toBe(true);
  });

  it('still sees a real edit', () => {
    expect(sameBotConfig({ ...draft, goal: 'Take more orders' }, draft)).toBe(false);
    expect(sameBotConfig({ ...draft, knowledge: [] }, draft)).toBe(false);
  });
});

describe('POST /api/bot/publish', () => {
  let repo: MemoryRepository;
  beforeEach(() => {
    repo = new MemoryRepository();
    vi.stubEnv('APP_MODE', 'demo');
    vi.stubEnv('ORDERLY_RUNTIME', '');
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('APP_URL', 'http://127.0.0.1:5173');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  const publish = (body: unknown) =>
    createApp(repo).request('http://127.0.0.1:4000/api/bot/publish', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-company-id': company.id,
        Origin: 'http://127.0.0.1:5173',
      },
      body: JSON.stringify(body),
    });
  const revision = async () => (await repo.getCompany(company.id))?.bot?.revision ?? 0;

  it('saves and publishes the settings on screen in one step', async () => {
    const config = { ...defaultBot, goal: 'Answer quickly and take orders.' };
    const response = await publish({ revision: await revision(), config });
    expect(response.status).toBe(200);
    const settings = (await response.json()) as BotSettings;
    expect(settings.published?.config.goal).toBe(config.goal);
    expect(settings.draft.goal).toBe(config.goal);
    const saved = (await repo.getCompany(company.id))!.bot!;
    expect(saved.published?.version).toBe(settings.published?.version);
    expect(sameBotConfig(saved.draft, saved.published?.config)).toBe(true);
  });

  it('refuses stale settings instead of overwriting someone else’s change', async () => {
    const current = await revision();
    expect((await publish({ revision: current, config: defaultBot })).status).toBe(200);
    expect((await publish({ revision: current, config: defaultBot })).status).toBe(409);
  });

  it('refuses to publish the screen and a saved version at once', async () => {
    const response = await publish({
      revision: await revision(),
      restoreVersion: 1,
      config: defaultBot,
    });
    expect(response.status).toBe(400);
  });
});

describe('save feedback', () => {
  it('shows a spinner and progress label on the pressed button without disabling it', () => {
    const html = renderToStaticMarkup(
      createElement(ActionButton, { loading: true, loadingLabel: 'Saving…' }, 'Save'),
    );
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('animate-spin');
    expect(html).toContain('Saving…');
    expect(html).not.toContain('Save<');
    expect(html).not.toContain('disabled');
    const idle = renderToStaticMarkup(createElement(ActionButton, {}, 'Save'));
    expect(idle).not.toContain('aria-busy');
    expect(idle).not.toContain('animate-spin');
  });

  it('announces errors right away and lets every notification be dismissed', () => {
    const error = renderToStaticMarkup(
      createElement(ToastItem, {
        toast: { id: 1, message: 'Could not save', tone: 'error' },
        onDismiss: () => {},
      }),
    );
    expect(error).toContain('role="alert"');
    expect(error).toContain('Could not save');
    expect(error).toContain('aria-label="Dismiss notification"');
    const saved = renderToStaticMarkup(
      createElement(ToastItem, {
        toast: { id: 2, message: 'Settings saved.', tone: 'success' },
        onDismiss: () => {},
      }),
    );
    expect(saved).not.toContain('role="alert"');
  });

  it('never greys out a whole screen while one change saves', () => {
    const dir = 'src/components';
    const offenders = readdirSync(dir)
      .filter((file) => file.endsWith('.tsx'))
      .filter((file) =>
        /disabled=\{[^}]*\bbusy\b/.test(readFileSync(`${dir}/${file}`, 'utf8')),
      );
    expect(offenders).toEqual([]);
    const app = readFileSync('src/App.tsx', 'utf8');
    expect(app).not.toMatch(/disabled=\{busy\}/);
  });
});
