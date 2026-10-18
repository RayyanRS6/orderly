import { useEffect, useRef, useState } from 'react';
import { Bell, X } from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';
import { api } from '../lib/api';
import { useWorkspace, type Page } from '../lib/workspace';
import type { StaffAttention } from '../shared/types';
import { shortDate } from '../lib/utils';
import { EmailAlerts } from './EmailAlerts';
import { clockTime, ErrorNotice, keepOpenForToasts } from './ui';

/**
 * What one alert says and where it leads. A kind this dashboard does not know yet (from a
 * newer server) still shows, and opens Activity.
 */
export function describeAlert(alert: StaffAttention['items'][number]): {
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
    case 'limit': {
      if (alert.scope === 'monthly') return { label: 'Monthly AI limit reached', page: 'bot' };
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

const preferenceKey = 'orderly-browser-alerts';
function enabledHere() {
  try {
    return localStorage.getItem(preferenceKey) === 'on';
  } catch {
    return false;
  }
}
export function StaffAlerts() {
  const { data, navigate } = useWorkspace();
  const [attention, setAttention] = useState<StaffAttention>();
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [enabled, setEnabled] = useState(enabledHere);
  const [permission, setPermission] = useState('');
  const seen = useRef(new Set<string>());
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    seen.current = new Set();
    setAttention(undefined);
    setError('');
    async function poll() {
      try {
        const result = await api<StaffAttention>('/attention', data.company.id);
        if (!active) return;
        setAttention(result);
        setError('');
        const fresh = result.items.filter((a) => !seen.current.has(a.id));
        seen.current = new Set(result.items.map((a) => a.id));
        if (
          fresh.length &&
          enabled &&
          'Notification' in window &&
          Notification.permission === 'granted'
        ) {
          try {
            const note = new Notification('Orderly needs your attention', {
              body: 'Open Orderly to review pending orders, staff handoffs, failed work or a reached AI limit.',
              tag: `orderly-${data.company.id}`,
            });
            note.onclick = () => {
              window.focus();
              setExpanded(true);
              note.close();
            };
          } catch {
            setPermission(
              'This browser cannot show background notifications. In-app alerts remain available.',
            );
          }
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        if (active) timer = setTimeout(() => void poll(), 20000);
      }
    }
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [data.company.id, enabled]);
  async function toggle() {
    if (enabled) {
      setEnabled(false);
      try {
        localStorage.removeItem(preferenceKey);
      } catch {}
      return;
    }
    if (!('Notification' in window)) {
      setPermission('Browser notifications are unavailable here. In-app alerts still work.');
      return;
    }
    try {
      const p = await Notification.requestPermission();
      if (p === 'granted') {
        setEnabled(true);
        setPermission('');
        try {
          localStorage.setItem(preferenceKey, 'on');
        } catch {}
      } else {
        setPermission(
          'Notifications were not enabled. You can change this in your browser’s site settings.',
        );
      }
    } catch {
      setPermission('Your browser could not enable notifications. In-app alerts still work.');
    }
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
          <div className="mb-4 flex items-center justify-between gap-2">
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
            <button
              className="min-h-9 rounded-full px-3.5 text-xs font-semibold text-brand-800 transition-colors hover:bg-brand-500/10 hover:text-brand-900"
              onClick={() => void toggle()}
            >
              {enabled ? 'Turn off browser alerts' : 'Enable browser alerts'}
            </button>
          </div>
          {permission && (
            <p role="status" className="mt-2 text-xs text-stone-600">
              {permission}
            </p>
          )}
          {expanded && (
            <div className="mt-3 space-y-3 text-sm">
              <p className="text-xs leading-5 text-stone-500">
                Live work only. Refreshes about every 20 seconds while this app is open. Browser
                alerts depend on browser permissions and background limits; they are not a phone
                push service. Configure email escalation below for alerts when the app is closed.
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
