import { useEffect, useRef, useState } from 'react';
import { Bell, X } from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';
import { api } from '../lib/api';
import { playChime, unlockChime } from '../lib/chime';
import { useWorkspace, type Page } from '../lib/workspace';
import type { StaffAttention } from '../shared/types';
import { shortDate } from '../lib/utils';
import { EmailAlerts } from './EmailAlerts';
import { clockTime, ErrorNotice, keepOpenForToasts } from './ui';

type Alert = StaffAttention['items'][number];
/**
 * What one alert says and where it leads. A kind this dashboard does not know yet (from a
 * newer server) still shows, and opens Activity.
 */
export function describeAlert(alert: Alert): {
  label: string;
  page: Page;
  id?: string;
} {
  switch (alert.kind) {
    case 'order':
      return { label: 'Order awaiting confirmation', page: 'orders', id: alert.entityId };
    case 'handoff':
      return { label: 'Conversation needs a person', page: 'inbox', id: alert.entityId };
    case 'job':
      return { label: 'Delivery or processing job failed', page: 'activity' };
    case 'budget':
      return { label: 'AI budget at 80% or more', page: 'bot' };
    case 'whatsapp':
      return { label: 'Linked phone is offline', page: 'integrations' };
    case 'limit': {
      if (alert.scope === 'monthly') return { label: 'Monthly AI limit reached', page: 'bot' };
      // A warning only: the bot still answers, and it is not counted as a reached limit.
      if (alert.scope === 'hourly_near')
        return { label: 'AI replies at 80% of this hour’s limit', page: 'bot' };
      const back = clockTime(alert.resetsAt);
      return {
        label:
          alert.scope === 'hourly'
            ? `Hourly AI limit reached${back ? ` · back at ${back}` : ''}`
            : 'AI limit reached',
        page: 'bot',
      };
    }
    default:
      return { label: 'Something needs attention', page: 'activity' };
  }
}

/** How often the alerts refresh. */
export const ALERT_POLL_MS = 60000;
/**
 * Whether to ask the server now. A tab in the background asks only when browser alerts are on,
 * since those exist for exactly that case; otherwise it waits until the tab is shown again.
 */
export function shouldPollAlerts(hidden: boolean, browserAlertsOn: boolean) {
  return !hidden || browserAlertsOn;
}
/**
 * Which alerts are new since the last check. The first check after opening (or switching
 * business, or turning alerts on) only learns what is already there, so a reload never raises
 * a notification or a chime for old work.
 */
export function newAlerts(seen: ReadonlySet<string> | undefined, items: Alert[]) {
  const fresh = seen ? items.filter((a) => !seen.has(a.id)) : [];
  return {
    fresh,
    orders: fresh.filter((a) => a.kind === 'order'),
    seen: new Set(items.map((a) => a.id)),
  };
}

/**
 * Whether new orders chime. Only the order sound decides: it works without browser
 * notifications (iPhone and iPad tabs have none, and staff may decline them), since turning
 * the sound on was itself the tap that allowed it.
 */
export function shouldChime(newOrders: number, soundOn: boolean) {
  return newOrders > 0 && soundOn;
}
/** Said where a granted permission still shows no notification (Chrome on Android, for one). */
export const BROWSER_ALERTS_UNAVAILABLE =
  'Browser alerts can’t be shown on this phone or browser. Turn on the order sound instead, keep this page open on screen, and set up email alerts below.';
/**
 * Shows a short test notification and says whether it could. Chrome on Android grants the
 * permission but refuses notifications made by a web page, so a granted permission alone does
 * not mean alerts will appear.
 */
export function testNotification() {
  try {
    const note = new Notification('Browser alerts are on', {
      body: 'Orderly will show new orders and other work here.',
      tag: 'orderly-test',
    });
    setTimeout(() => note.close(), 4000);
    return true;
  } catch {
    return false;
  }
}

const preferenceKey = 'orderly-browser-alerts';
const soundKey = 'orderly-alert-sound';
function enabledHere(key = preferenceKey) {
  try {
    return localStorage.getItem(key) === 'on';
  } catch {
    return false;
  }
}
function remember(key: string, on: boolean) {
  try {
    if (on) localStorage.setItem(key, 'on');
    else localStorage.removeItem(key);
  } catch {}
}
const browserAlertsOn = (enabled: boolean) =>
  enabled && 'Notification' in window && Notification.permission === 'granted';
export function StaffAlerts({
  onWaitingOrders,
}: {
  /** Real customer orders waiting for acceptance (undefined until known), for the tab title. */
  onWaitingOrders?: (count: number | undefined) => void;
} = {}) {
  const { data, navigate } = useWorkspace();
  const [attention, setAttention] = useState<StaffAttention>();
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [enabled, setEnabled] = useState(() => enabledHere());
  const [sound, setSound] = useState(() => enabledHere(soundKey));
  const [permission, setPermission] = useState('');
  const seen = useRef<Set<string> | undefined>(undefined);
  const soundOn = useRef(sound);
  soundOn.current = sound;
  const reportOrders = useRef(onWaitingOrders);
  reportOrders.current = onWaitingOrders;
  // A sound chosen on an earlier visit can play once this page has been tapped or typed in.
  // Every tap or key press allows it again, since iPhones and iPads silence a page's sound
  // after the screen locks or the tab goes to the background.
  useEffect(() => {
    if (!sound) return;
    const unlock = () => unlockChime();
    window.addEventListener('pointerdown', unlock, { capture: true });
    window.addEventListener('keydown', unlock, { capture: true });
    return () => {
      window.removeEventListener('pointerdown', unlock, { capture: true });
      window.removeEventListener('keydown', unlock, { capture: true });
    };
  }, [sound]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    // Set when a check was skipped in a background tab: the tab being shown again checks at once.
    let waiting = false;
    seen.current = undefined;
    setAttention(undefined);
    setError('');
    reportOrders.current?.(undefined);
    async function poll() {
      if (!shouldPollAlerts(document.hidden, browserAlertsOn(enabled))) {
        waiting = true;
        return;
      }
      try {
        const result = await api<StaffAttention>('/attention', data.company.id);
        if (!active) return;
        setAttention(result);
        setError('');
        reportOrders.current?.(result.orders);
        const { fresh, orders, seen: next } = newAlerts(seen.current, result.items);
        seen.current = next;
        // With or without browser alerts: turning the sound on was the tap that allowed it.
        if (shouldChime(orders.length, soundOn.current)) playChime();
        if (fresh.length && browserAlertsOn(enabled)) {
          try {
            const note = new Notification('Orderly needs your attention', {
              body: 'Open Orderly to review pending orders, staff handoffs, failed work, a reached AI limit or a linked phone that stopped.',
              // A tag of its own, so a new alert never silently replaces one still on screen.
              tag: `orderly-${data.company.id}-${fresh[0]!.id}`,
            });
            note.onclick = () => {
              window.focus();
              setExpanded(true);
              note.close();
            };
          } catch {
            // Turned on during an earlier visit on a browser that can't show them: say so, and
            // stop asking in the background for alerts that never appear.
            setEnabled(false);
            remember(preferenceKey, false);
            setPermission(BROWSER_ALERTS_UNAVAILABLE);
          }
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        if (active) timer = setTimeout(() => void poll(), ALERT_POLL_MS);
      }
    }
    const shown = () => {
      if (document.hidden || !waiting) return;
      waiting = false;
      clearTimeout(timer);
      void poll();
    };
    document.addEventListener('visibilitychange', shown);
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', shown);
    };
  }, [data.company.id, enabled]);
  async function toggle() {
    if (enabled) {
      setEnabled(false);
      remember(preferenceKey, false);
      return;
    }
    if (!('Notification' in window)) {
      setPermission(BROWSER_ALERTS_UNAVAILABLE);
      return;
    }
    // This click is what lets the order sound play later, if it is turned on.
    unlockChime();
    try {
      const p = await Notification.requestPermission();
      if (p === 'granted' && !testNotification()) {
        // Allowed, yet this browser shows nothing (Chrome on Android): not reported as on.
        setPermission(BROWSER_ALERTS_UNAVAILABLE);
      } else if (p === 'granted') {
        setEnabled(true);
        setPermission('');
        remember(preferenceKey, true);
      } else {
        setPermission(
          'Notifications were not enabled. You can change this in your browser’s site settings.',
        );
      }
    } catch {
      setPermission('Your browser could not enable notifications. In-app alerts still work.');
    }
  }
  function toggleSound() {
    if (sound) {
      setSound(false);
      remember(soundKey, false);
      return;
    }
    // This click is what lets the browser play it later.
    if (!unlockChime()) {
      setPermission('This browser can’t play the order sound. In-app alerts still work.');
      return;
    }
    setSound(true);
    setPermission('');
    remember(soundKey, true);
  }
  return (
    <Dialog.Root open={expanded} onOpenChange={setExpanded}>
      <Dialog.Trigger asChild>
        <button
          className="icon-btn-glass relative"
          aria-label={
            error ? 'Staff alerts unavailable' : `Staff alerts: ${attention?.total ?? 0} unresolved`
          }
        >
          <Bell className={attention?.total ? 'pulse-squish size-4' : 'size-4'} />
          {!!attention?.total && (
            <span className="pop-in absolute -right-1.5 -top-1.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-brand-500 px-1 text-[10px] font-bold leading-none text-ink tabular-nums shadow-[0_6px_12px_-6px_rgb(255_105_44/0.9)] ring-2 ring-canvas">
              {attention.total > 99 ? '99+' : attention.total}
            </span>
          )}
          {error && (
            <span className="pop-in absolute -right-1.5 -top-1.5 grid size-[18px] place-items-center rounded-full bg-red-700 text-[11px] font-bold leading-none text-white ring-2 ring-canvas">
              !
            </span>
          )}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay fixed inset-0 z-40" />
        <Dialog.Content
          onInteractOutside={keepOpenForToasts}
          className="dialog-content fixed inset-x-3 top-[10dvh] z-50 mx-auto max-h-[80dvh] max-w-xl overflow-y-auto rounded-[22px] border border-white bg-cream bg-[radial-gradient(420px_circle_at_100%_0%,rgb(255_105_44/0.1),transparent_70%)] bg-no-repeat p-5 shadow-[0_40px_80px_-30px_rgb(14_6_4/0.5),0_10px_24px_-14px_rgb(14_6_4/0.15)] sm:p-6"
        >
          {/* On phones a long list scrolls under this row, so Close stays in reach. */}
          <div className="mb-4 flex items-center justify-between gap-2 max-sm:sticky max-sm:top-0 max-sm:z-10 max-sm:-mx-5 max-sm:-mt-5 max-sm:mb-2 max-sm:px-5 max-sm:pt-5 max-sm:pb-2 max-sm:[background:inherit]">
            <Dialog.Title className="panel-title">Staff alerts</Dialog.Title>
            <Dialog.Close className="icon-btn-glass" aria-label="Close staff alerts">
              <X className="size-4" />
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">
            Unresolved orders, conversations, processing failures and reached AI limits for this
            business.
          </Dialog.Description>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex min-h-9 items-center gap-2.5 text-left text-sm font-semibold text-ink">
              <Bell className="box-content size-4 shrink-0 -rotate-6 rounded-lg bg-brand-500 p-1.5 text-ink shadow-[0_8px_16px_-8px_rgb(255_105_44/0.9)]" />
              {error
                ? 'Alerts could not refresh'
                : attention
                  ? attention.total
                    ? `${attention.total} ${attention.total === 1 ? 'item needs' : 'items need'} attention`
                    : 'No unresolved staff alerts'
                  : 'Checking staff alerts…'}
            </p>
            <div className="flex flex-wrap items-center gap-1">
              {/* On its own: phones and tablets without browser alerts can still chime. */}
              <button
                className="min-h-9 rounded-full px-3.5 text-xs font-semibold text-brand-800 transition-colors hover:bg-brand-500/10 hover:text-brand-900"
                aria-pressed={sound}
                onClick={toggleSound}
              >
                {sound ? 'Turn off order sound' : 'Play a sound for new orders'}
              </button>
              <button
                className="min-h-9 rounded-full px-3.5 text-xs font-semibold text-brand-800 transition-colors hover:bg-brand-500/10 hover:text-brand-900"
                onClick={() => void toggle()}
              >
                {enabled ? 'Turn off browser alerts' : 'Enable browser alerts'}
              </button>
            </div>
          </div>
          {permission && (
            <p role="status" className="mt-2 text-xs text-stone-600">
              {permission}
            </p>
          )}
          {expanded && (
            <div className="mt-3 space-y-3 text-sm">
              <p className="text-xs leading-5 text-stone-500">
                Live work only. Refreshes about once a minute while this page is on screen, and in a
                background tab only with browser alerts on. Browser alerts depend on browser
                permissions and background limits; they are not a phone push service, and Chrome on
                Android and iPhone or iPad tabs can’t show them. The order sound plays while this
                page is on screen. Configure email escalation below for alerts when the app is
                closed.
              </p>
              {error && <ErrorNotice message={`${error} Retrying automatically.`} />}
              {attention && (
                <div className="stagger flex flex-wrap gap-2">
                  <button
                    className="btn"
                    onClick={() => {
                      setExpanded(false);
                      navigate('orders');
                    }}
                  >
                    {attention.orders} pending {attention.orders === 1 ? 'order' : 'orders'}
                  </button>
                  <button
                    className="btn"
                    onClick={() => {
                      setExpanded(false);
                      navigate('inbox');
                    }}
                  >
                    {attention.handoffs} human {attention.handoffs === 1 ? 'handoff' : 'handoffs'}
                  </button>
                  <button
                    className="btn"
                    onClick={() => {
                      setExpanded(false);
                      navigate('activity');
                    }}
                  >
                    {attention.failures} failed {attention.failures === 1 ? 'job' : 'jobs'}
                  </button>
                  {!!attention.budgets && (
                    <button
                      className="btn border-sun/70 bg-sun/20 text-ink hover:border-sun hover:bg-sun/35"
                      onClick={() => {
                        setExpanded(false);
                        navigate('bot');
                      }}
                    >
                      AI budget at 80% or more
                    </button>
                  )}
                  {/* Older servers do not count limits. */}
                  {!!(attention.limits ?? 0) && (
                    <button
                      className="btn border-sun/70 bg-sun/20 text-ink hover:border-sun hover:bg-sun/35"
                      onClick={() => {
                        setExpanded(false);
                        navigate('bot');
                      }}
                    >
                      AI limit reached
                    </button>
                  )}
                  {/* Older servers do not count linked phones. */}
                  {!!(attention.whatsapp ?? 0) && (
                    <button
                      className="btn border-sun/70 bg-sun/20 text-ink hover:border-sun hover:bg-sun/35"
                      onClick={() => {
                        setExpanded(false);
                        navigate('integrations');
                      }}
                    >
                      Linked phone offline
                    </button>
                  )}
                </div>
              )}
              <ul className="stagger space-y-2">
                {attention?.items.map((a) => {
                  const target = describeAlert(a);
                  return (
                    <li key={a.id}>
                      <button
                        className="lift flex min-h-11 w-full flex-wrap items-center justify-between gap-2 rounded-2xl border border-ink/[0.06] bg-white px-3.5 py-2.5 text-left"
                        onClick={() => {
                          setExpanded(false);
                          navigate(target.page, target.id);
                        }}
                      >
                        <span className="font-medium text-ink">{target.label}</span>
                        <time className="font-mono text-[11px] text-stone-500">
                          {shortDate(a.createdAt)}
                          {a.kind === 'handoff' &&
                            Date.now() - Date.parse(a.createdAt) > 10 * 60000 && (
                              <span className="pop-in ml-2 inline-flex rounded-full bg-red-50 px-2 py-0.5 font-sans text-[11px] font-semibold text-red-700">
                                Waiting over 10 minutes
                              </span>
                            )}
                        </time>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {(attention?.total ?? 0) > 30 && (
                <p className="text-xs text-stone-500">
                  Showing the latest 30 alerts. Use the counts above to review all work.
                </p>
              )}
            </div>
          )}
          <EmailAlerts key={data.company.id} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
