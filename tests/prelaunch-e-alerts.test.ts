import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ALERT_POLL_MS,
  describeAlert,
  newAlerts,
  shouldPollAlerts,
} from '../src/components/StaffAlerts';
import { AutomationPausedBanner } from '../src/App';
import { titleWithCount } from '../src/lib/utils';
import { playChime, unlockChime } from '../src/lib/chime';
import type { StaffAttention } from '../src/shared/types';

type Alert = StaffAttention['items'][number];
const item = (extra: Partial<Alert>): Alert => ({
  id: 'a1',
  kind: 'order',
  entityId: 'e1',
  createdAt: '2026-10-18T10:00:00.000Z',
  ...extra,
});
const source = (file: string) => readFileSync(join(process.cwd(), file), 'utf8');

describe('staff alerts for the new server alerts', () => {
  it('sends a linked phone that stopped to Integrations', () => {
    expect(describeAlert(item({ kind: 'whatsapp', entityId: 'connection-1' }))).toEqual({
      label: 'Linked phone is offline',
      page: 'integrations',
    });
    expect(source('src/components/StaffAlerts.tsx')).toContain('Linked phone offline');
  });

  it('shows 80% of the hourly limit as a warning on Bot settings, not as a reached limit', () => {
    const near = describeAlert(
      item({ kind: 'limit', scope: 'hourly_near', resetsAt: '2026-10-18T11:00:00.000Z' }),
    );
    expect(near).toEqual({ label: 'AI replies at 80% of this hour’s limit', page: 'bot' });
    expect(near.label).not.toMatch(/reached/);
  });
});

describe('how often staff alerts ask the server', () => {
  it('asks once a minute, and in a background tab only with browser alerts on', () => {
    expect(ALERT_POLL_MS).toBe(60000);
    expect(shouldPollAlerts(false, false)).toBe(true);
    expect(shouldPollAlerts(true, false)).toBe(false);
    expect(shouldPollAlerts(true, true)).toBe(true);
  });

  it('raises nothing for work that was already there when the page opened', () => {
    const first = newAlerts(undefined, [
      item({ id: 'old-order' }),
      item({ id: 'job', kind: 'job' }),
    ]);
    expect(first.fresh).toEqual([]);
    expect(first.orders).toEqual([]);
    const next = newAlerts(first.seen, [
      item({ id: 'old-order' }),
      item({ id: 'new-order' }),
      item({ id: 'handoff', kind: 'handoff' }),
    ]);
    expect(next.fresh.map((a) => a.id)).toEqual(['new-order', 'handoff']);
    // Only a new order chimes.
    expect(next.orders.map((a) => a.id)).toEqual(['new-order']);
  });

  it('keeps sound silent until a tap allowed it, and never fails without Web Audio', () => {
    expect(unlockChime()).toBe(false);
    expect(() => playChime()).not.toThrow();
  });

  it('describes the refresh and the sound option in the alerts dialog', () => {
    const alerts = source('src/components/StaffAlerts.tsx');
    expect(alerts).toContain('Refreshes about once a minute while this page is on screen');
    expect(alerts).not.toContain('every 20 seconds');
    expect(alerts).toContain('Play a sound for new orders');
    // Each alert has its own tag, so a second one never silently replaces the first.
    expect(alerts).toContain('tag: `orderly-${data.company.id}-${fresh[0]!.id}`');
  });
});

describe('the tab title', () => {
  it('leads with the orders waiting for acceptance', () => {
    expect(titleWithCount('Orders · Laziza — Orderly', 2)).toBe('(2) Orders · Laziza — Orderly');
    expect(titleWithCount('Orders · Laziza — Orderly', 0)).toBe('Orders · Laziza — Orderly');
    expect(titleWithCount('Orders · Laziza — Orderly', undefined)).toBe(
      'Orders · Laziza — Orderly',
    );
    expect(titleWithCount('Orders', 140)).toBe('(99+) Orders');
  });

  it('is fed by the staff alerts on every workspace page', () => {
    const app = source('src/App.tsx');
    expect(app).toContain('<StaffAlerts onWaitingOrders={setWaitingOrders} />');
    expect(app).toMatch(/titleWithCount\([\s\S]*?waitingOrders,\s*\)/);
  });
});

describe('the emergency stop', () => {
  it('shows a banner saying what still works', () => {
    expect(renderToStaticMarkup(createElement(AutomationPausedBanner))).toContain(
      'Automatic replies are paused for every business (emergency stop). The inbox and staff replies still work.',
    );
    const app = source('src/App.tsx');
    expect(app).toContain('{automationPaused && <AutomationPausedBanner />}');
    expect(app).toContain('setAutomationPaused(!!result.automationPaused);');
  });

  it('checks again when turning a bot on is refused, so the banner says why', () => {
    expect(source('src/App.tsx')).toMatch(
      /e instanceof ApiError && e\.status === 409 && path\.startsWith\('\/companies\/'\)\)\s*void api<Configuration>\('\/config'\)/,
    );
  });
});
