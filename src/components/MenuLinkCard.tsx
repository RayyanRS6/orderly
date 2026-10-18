import { useEffect, useState } from 'react';
import { Copy, ExternalLink, Info } from 'lucide-react';
import type { MenuLinkStatus } from '../shared/menu';
import { api } from '../lib/api';
import { useAction, useWorkspace } from '../lib/workspace';
import { ErrorNotice, Spinner } from './ui';

/** The owner's switch for the public menu page, with its fixed link. */
export function MenuLinkCard() {
  const { data, mutate, notify } = useWorkspace();
  const { pending, run } = useAction();
  // undefined while loading, null when it could not be loaded.
  const [status, setStatus] = useState<MenuLinkStatus | null>();
  const [error, setError] = useState('');
  const companyId = data.company.id;
  useEffect(() => {
    let live = true;
    api<MenuLinkStatus>('/menu-link', companyId).then(
      (value) => live && setStatus(value),
      (e: Error) => {
        if (!live) return;
        setStatus(null);
        setError(e.message);
      },
    );
    return () => {
      live = false;
    };
  }, [companyId]);
  const canChange = data.role !== 'staff';
  const toggle = (enabled: boolean) =>
    void run('menu-link', async () => {
      setError('');
      setStatus(
        await mutate<MenuLinkStatus>('/menu-link', { enabled }, 'PUT', {
          success: enabled ? 'Menu page is on.' : 'Menu page is off.',
        }),
      );
    }).catch(() => undefined);
  const copy = (url: string) =>
    navigator.clipboard?.writeText(url).then(
      () => notify('Menu link copied.'),
      () => notify('Copy the link from the box instead.', 'info'),
    );
  return (
    <section className="card mb-6 p-5 sm:p-6" aria-labelledby="menu-page-title">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 max-w-xl">
          <p className="eyebrow">Menu page</p>
          <h2 id="menu-page-title" className="panel-title mt-2">
            Your menu as a web page
          </h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-stone-500">
            Customers see your menu with photos and order in a few taps. The bot adds the link
            whenever it shows the menu, and you can share it on Instagram or a QR code.
          </p>
        </div>
        <label className="flex shrink-0 cursor-pointer items-center gap-2.5 text-sm font-medium text-stone-600">
          {/* Until the status loads, show it loading rather than a wrong 'Off'. */}
          {(pending === 'menu-link' || status === undefined) && <Spinner className="size-3.5" />}
          <input
            className="toggle"
            type="checkbox"
            aria-label="Menu page on"
            checked={!!status?.enabled}
            disabled={!canChange || !status || pending === 'menu-link'}
            onChange={(e) => toggle(e.target.checked)}
          />
          {status ? (status.enabled ? 'On' : 'Off') : ''}
        </label>
      </div>
      {status?.enabled && status.url && (
        <div className="mt-4">
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="input min-w-0 font-mono text-[12.5px] sm:flex-1"
              readOnly
              aria-label="Menu page link"
              value={status.url}
              onFocus={(e) => e.currentTarget.select()}
            />
            <button type="button" className="btn" onClick={() => copy(status.url!)}>
              <Copy className="size-4" />
              Copy
            </button>
            <a className="btn" href={status.url} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="size-4" />
              Open
            </a>
          </div>
          <p className="mt-2 text-xs text-stone-500">
            This link never changes, even if you rename your business.
          </p>
        </div>
      )}
      {!canChange && (
        <p className="mt-3 text-xs text-stone-500">
          Only an owner can turn the menu page on or off.
        </p>
      )}
      {status?.notes.map((note) => (
        <p
          key={note}
          className="mt-3 flex items-start gap-2 rounded-xl bg-sun/20 px-3 py-2 text-xs leading-relaxed text-stone-700"
        >
          <Info className="mt-0.5 size-3.5 shrink-0" />
          {note}
        </p>
      ))}
      {error && (
        <div className="mt-3">
          <ErrorNotice message={error} onDismiss={() => setError('')} />
        </div>
      )}
    </section>
  );
}
