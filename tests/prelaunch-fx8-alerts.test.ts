// FX-8 (frontend-2, frontend-3, frontend-5): browser alerts are reported as on only where a
// notification can really appear (not Chrome on Android), the order sound works on its own
// (iPhone, iPad, or notifications declined), and the emergency-stop banner is checked again.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BROWSER_ALERTS_UNAVAILABLE,
  newAlerts,
  shouldChime,
  shouldPollAlerts,
  testNotification,
} from '../src/components/StaffAlerts';
import type { StaffAttention } from '../src/shared/types';

const source = (file: string) => readFileSync(join(process.cwd(), file), 'utf8');
type Alert = StaffAttention['items'][number];
const item = (extra: Partial<Alert>): Alert => ({
  id: 'a1',
  kind: 'order',
  entityId: 'e1',
  createdAt: '2026-10-19T10:00:00.000Z',
  ...extra,
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the order sound on its own', () => {
  it('chimes for a new order whenever the sound is on, with or without browser alerts', () => {
    expect(shouldChime(1, true)).toBe(true);
    expect(shouldChime(0, true)).toBe(false);
    expect(shouldChime(2, false)).toBe(false);
    // Only a new order chimes, and only after the first check (as before).
    const first = newAlerts(undefined, [item({ id: 'old' })]);
    const next = newAlerts(first.seen, [item({ id: 'old' }), item({ id: 'new' })]);
    expect(shouldChime(first.orders.length, true)).toBe(false);
    expect(shouldChime(next.orders.length, true)).toBe(true);
  });

  it('offers the sound without browser alerts, and plays it without notification permission', () => {
    const alerts = source('src/components/StaffAlerts.tsx');
    expect(alerts).toContain('if (shouldChime(orders.length, soundOn.current)) playChime();');
    expect(alerts).not.toMatch(/soundOn\.current && browserAlertsOn\(enabled\)/);
    // The sound button is no longer shown only with browser alerts on.
    expect(alerts).not.toMatch(
      /\{enabled && \(\s*<button[\s\S]{0,400}?Play a sound for new orders/,
    );
    expect(alerts).toContain("{sound ? 'Turn off order sound' : 'Play a sound for new orders'}");
    // A visible tab is checked with browser alerts off, so a foreground iPad chimes.
    expect(shouldPollAlerts(false, false)).toBe(true);
    // Every tap allows sound again after iOS silenced the page.
    expect(alerts).toContain("window.addEventListener('pointerdown', unlock, { capture: true });");
    expect(alerts).not.toContain('once: true');
    expect(alerts).toContain('This browser can’t play the order sound. In-app alerts still work.');
  });
});

describe('browser alerts that cannot appear', () => {
  it('tries a test notification, which Chrome on Android refuses', () => {
    vi.useFakeTimers();
    const close = vi.fn();
    vi.stubGlobal(
      'Notification',
      class {
        close = close;
      },
    );
    expect(testNotification()).toBe(true);
    vi.advanceTimersByTime(4000);
    expect(close).toHaveBeenCalled();
    vi.stubGlobal(
      'Notification',
      class {
        constructor() {
          throw new TypeError('Illegal constructor');
        }
      },
    );
    expect(testNotification()).toBe(false);
  });

  it('is not reported as on, says so, and points to the sound and email alerts', () => {
    expect(BROWSER_ALERTS_UNAVAILABLE).toMatch(/can’t be shown on this phone or browser/);
    expect(BROWSER_ALERTS_UNAVAILABLE).toMatch(/order sound/);
    expect(BROWSER_ALERTS_UNAVAILABLE).toMatch(/email alerts/);
    const alerts = source('src/components/StaffAlerts.tsx');
    // A granted permission without a working notification stores nothing and stays off.
    expect(alerts).toMatch(
      /if \(p === 'granted' && !testNotification\(\)\) \{[\s\S]*?setPermission\(BROWSER_ALERTS_UNAVAILABLE\);\s*\} else if \(p === 'granted'\) \{\s*setEnabled\(true\);/,
    );
    // 'On' kept from an earlier visit is switched off at the first alert that can't be shown.
    expect(alerts).toMatch(
      /\} catch \{[\s\S]{0,300}?setEnabled\(false\);\s*remember\(preferenceKey, false\);\s*setPermission\(BROWSER_ALERTS_UNAVAILABLE\);/,
    );
    // In-page alerts are unchanged: the badge, the list and each alert's own tag.
    expect(alerts).toContain('tag: `orderly-${data.company.id}-${fresh[0]!.id}`');
    expect(alerts).toContain('Refreshes about once a minute while this page is on screen');
  });
});

describe('the emergency-stop banner', () => {
  it('is checked again every few minutes while the page is on screen', () => {
    const app = source('src/App.tsx');
    expect(app).toContain('{automationPaused && <AutomationPausedBanner />}');
    expect(app).toMatch(
      /pollWhileVisible\(\(\) => \{\s*void api<Configuration>\('\/config'\)\s*\.then\(\(c\) => setAutomationPaused\(!!c\.automationPaused\)\)/,
    );
    // Still checked at once when turning a bot on is refused.
    expect(app).toMatch(
      /e instanceof ApiError && e\.status === 409 && path\.startsWith\('\/companies\/'\)\)\s*void api<Configuration>\('\/config'\)/,
    );
  });
});
