import { useEffect, useRef, useState } from 'react';
import { Bell, X } from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';
import { api } from '../lib/api';
import { useWorkspace } from '../lib/workspace';
import type { StaffAttention } from '../shared/types';
import { EmailAlerts } from './EmailAlerts';

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
              body: 'Open Orderly to review pending orders, staff handoffs or failed work.',
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
          <Bell className="size-4" />
          {!!attention?.total && (
            <span className="absolute -right-1 -top-1 rounded-full bg-brand-500 px-1 text-[10px] font-bold text-white">
              {attention.total > 99 ? '99+' : attention.total}
            </span>
          )}
          {error && (
            <span className="absolute -right-1 -top-1 rounded-full bg-red-700 px-1 text-xs text-white">
              !
            </span>
          )}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/45 backdrop-blur-xs" />
        <Dialog.Content className="fixed inset-x-3 top-[10dvh] z-50 mx-auto max-h-[80dvh] max-w-xl overflow-y-auto rounded-2xl border border-white bg-cream p-5 shadow-xl sm:p-6">
          <div className="mb-4 flex items-center justify-between gap-2">
            <Dialog.Title className="panel-title">Staff alerts</Dialog.Title>
            <Dialog.Close className="icon-btn-glass" aria-label="Close staff alerts">
              <X className="size-4" />
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">
            Unresolved orders, conversations and processing failures for this business.
          </Dialog.Description>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex min-h-9 items-center gap-2 text-sm font-semibold text-left">
              <Bell className="size-4 shrink-0" />
              {error
                ? 'Alerts could not refresh'
                : attention
                  ? attention.total
                    ? `${attention.total} items need attention`
                    : 'No unresolved staff alerts'
                  : 'Checking staff alerts…'}
            </p>
            <button
              className="min-h-9 text-xs font-semibold text-brand-600"
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
              {error && (
                <p role="alert" className="text-red-700">
                  {error} Retrying automatically.
                </p>
              )}
              {attention && (
                <div className="flex flex-wrap gap-2">
                  <button
                    className="btn"
                    onClick={() => {
                      setExpanded(false);
                      navigate('orders');
                    }}
                  >
                    {attention.orders} pending orders
                  </button>
                  <button
                    className="btn"
                    onClick={() => {
                      setExpanded(false);
                      navigate('inbox');
                    }}
                  >
                    {attention.handoffs} human handoffs
                  </button>
                  <button
                    className="btn"
                    onClick={() => {
                      setExpanded(false);
                      navigate('activity');
                    }}
                  >
                    {attention.failures} failed jobs
                  </button>
                  {!!attention.budgets && (
                    <button
                      className="btn text-amber-800"
                      onClick={() => {
                        setExpanded(false);
                        navigate('bot');
                      }}
                    >
                      AI budget at 80% or more
                    </button>
                  )}
                </div>
              )}
              <ul className="divide-y divide-ink/5">
                {attention?.items.map((a) => (
                  <li key={a.id}>
                    <button
                      className="flex min-h-11 w-full flex-wrap items-center justify-between gap-2 py-2 text-left"
                      onClick={() => {
                        setExpanded(false);
                        navigate(
                          a.kind === 'order'
                            ? 'orders'
                            : a.kind === 'handoff'
                              ? 'inbox'
                              : a.kind === 'budget'
                                ? 'bot'
                                : 'activity',
                          a.kind === 'job' || a.kind === 'budget' ? undefined : a.entityId,
                        );
                      }}
                    >
                      <span>
                        {a.kind === 'order'
                          ? 'Order awaiting confirmation'
                          : a.kind === 'handoff'
                            ? 'Conversation needs a person'
                            : a.kind === 'budget'
                              ? 'AI budget at 80% or more'
                              : 'Delivery or processing job failed'}
                      </span>
                      <time className="text-xs text-stone-500">
                        {new Date(a.createdAt).toLocaleString()}
                        {a.kind === 'handoff' &&
                          Date.now() - Date.parse(a.createdAt) > 10 * 60000 && (
                            <span className="ml-2 font-semibold text-red-700">
                              Waiting over 10 minutes
                            </span>
                          )}
                      </time>
                    </button>
                  </li>
                ))}
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
