import { useEffect, useState } from 'react';
import type { BlockedCustomer } from '../shared/types';
import { api } from '../lib/api';
import { useAction, useWorkspace } from '../lib/workspace';
import { shortDate } from '../lib/utils';
import { ActionButton, ErrorNotice } from './ui';

/** Every blocked number, with a way to unblock it. Staff can see it too: they block from the Inbox. */
export function BlockedNumbers() {
  const { data, mutate } = useWorkspace();
  const { pending, run } = useAction();
  const [blocked, setBlocked] = useState<BlockedCustomer[]>();
  const [error, setError] = useState('');
  // Bumped after an unblock, so the list loads again.
  const [loads, setLoads] = useState(0);
  useEffect(() => {
    let active = true;
    api<BlockedCustomer[]>('/blocked', data.company.id)
      .then((r) => {
        if (active) {
          setBlocked(r);
          setError('');
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [data.company.id, loads]);
  // A failure shows as a notification (from mutate). The list loads again either way, so a
  // number someone else already unblocked drops off instead of failing again.
  const unblock = (blockId: string) =>
    void run(`unblock-${blockId}`, async () => {
      try {
        await mutate(`/blocked/${encodeURIComponent(blockId)}`, undefined, 'DELETE', {
          success: 'Number unblocked. The bot will answer them again.',
        });
      } finally {
        setLoads((n) => n + 1);
      }
    }).catch(() => undefined);
  return (
    <section className="card mb-6 p-5 sm:p-6 space-y-4">
      <h2 className="panel-title">Blocked numbers</h2>
      <ErrorNotice message={error} />
      <p className="text-sm leading-6 text-stone-500">
        Messages from these numbers are ignored before they are saved. Staff can block a number from
        its chat in the Inbox.
      </p>
      {!blocked && !error && <p className="text-sm text-stone-500">Loading blocked numbers…</p>}
      {blocked && !blocked.length && (
        <p className="rounded-2xl border border-dashed border-ink/10 bg-paper/70 px-4 py-6 text-center text-sm text-stone-500">
          No blocked numbers.
        </p>
      )}
      {!!blocked?.length && (
        <ul className="stagger divide-y divide-ink/[0.05]">
          {blocked.map((b) => (
            <li key={b.blockId} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="break-words text-sm font-semibold text-ink">
                  {b.label || 'WhatsApp contact'}
                </p>
                <p className="mt-1 text-xs text-stone-500">
                  Blocked {shortDate(b.createdAt)} · {b.blockedCount.toLocaleString('en-US')}{' '}
                  {b.blockedCount === 1 ? 'message' : 'messages'} ignored
                  {b.lastBlockedAt && `, last ${shortDate(b.lastBlockedAt)}`}
                </p>
              </div>
              <ActionButton
                className="btn-quiet"
                aria-label={`Unblock ${b.label || 'WhatsApp contact'}`}
                loading={pending === `unblock-${b.blockId}`}
                loadingLabel="Unblocking…"
                onClick={() => unblock(b.blockId)}
              >
                Unblock
              </ActionButton>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
