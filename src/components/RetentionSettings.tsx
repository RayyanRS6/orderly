import { useEffect, useState } from 'react';
import type { RetentionStatus } from '../shared/types';
import { api } from '../lib/api';
import { useWorkspace } from '../lib/workspace';
import { ConfirmDialog, ErrorNotice, Field } from './ui';

export function RetentionSettings() {
  const { data } = useWorkspace();
  const [status, setStatus] = useState<RetentionStatus>();
  const [days, setDays] = useState('0');
  const [preview, setPreview] = useState<{ days: number; count: number }>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    let active = true;
    api<RetentionStatus>('/privacy/retention', data.company.id)
      .then((r) => {
        if (active) {
          setStatus(r);
          setDays(String(r.days));
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [data.company.id]);
  async function inspect() {
    setBusy(true);
    setError('');
    try {
      const r = await api<RetentionStatus>(
        `/privacy/retention?days=${encodeURIComponent(days)}`,
        data.company.id,
      );
      setPreview({ days: Number(days), count: r.eligibleConversations });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    setBusy(true);
    setError('');
    try {
      const r = await api<RetentionStatus>(
        '/privacy/retention',
        data.company.id,
        { days: Number(days), confirmed: true },
        'PUT',
      );
      setStatus(r);
      setPreview(undefined);
      setConfirm(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card mb-6 p-5 sm:p-6 space-y-4">
      <h2 className="panel-title">Automatic data retention</h2>
      <ErrorNotice message={error} />
      <p className="text-sm leading-6 text-stone-500">
        Off by default. Deletes inactive conversations and their finished orders, message history
        and related logs from Orderly. Unfinished orders, human handoffs and outstanding jobs are
        protected. Sheet copies, providers, exports and backups require separate handling.
      </p>
      <p className="text-sm font-semibold">
        {status
          ? status.days
            ? `Enabled: ${status.days} days of inactivity`
            : 'Automatic deletion is off'
          : 'Loading policy…'}
      </p>
      <Field
        label="Days of inactivity"
        hint="Enter 0 to turn off, or 30–3650 days. Choose a period that meets your business’s recordkeeping obligations."
      >
        <input
          className="input max-w-xs"
          type="number"
          min="0"
          max="3650"
          step="1"
          value={days}
          disabled={busy || !status}
          onChange={(e) => {
            setDays(e.target.value);
            setPreview(undefined);
          }}
        />
      </Field>
      <button className="btn" disabled={busy || !status || !days} onClick={() => void inspect()}>
        Preview policy
      </button>
      {preview && (
        <div className="space-y-3 text-sm">
          <p>
            {preview.days === 0
              ? 'This will disable automatic deletion.'
              : `${preview.count}${preview.count === 100 ? '+' : ''} conversations currently qualify for the next batch. Counts can change as customers and staff act.`}
          </p>
          <button
            className="btn-primary"
            disabled={busy || preview.days !== Number(days) || preview.days === status?.days}
            onClick={() => setConfirm(true)}
          >
            Save retention policy
          </button>
        </div>
      )}
      {status?.eligibleAfter && status.days > 0 && (
        <p className="text-xs text-stone-500">
          Cleanup cannot start before {new Date(status.eligibleAfter).toLocaleString()}. A changed
          policy has a 24-hour grace period. Cleanup runs hourly in batches of up to 100
          conversations per workspace; busy workspaces are skipped.
        </p>
      )}
      {status?.lastRunAt && (
        <p className="text-xs text-stone-500">
          Last cleanup: {new Date(status.lastRunAt).toLocaleString()} · {status.lastDeleted}{' '}
          conversations deleted.
        </p>
      )}
      {data.mode === 'demo' && (
        <p className="text-xs text-stone-500">
          Local demo: policy and preview work, but scheduled cleanup only runs on Supabase.
        </p>
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        busy={busy}
        title={Number(days) ? 'Enable automatic deletion?' : 'Turn off automatic deletion?'}
        description={
          Number(days)
            ? `After a 24-hour grace period, eligible records inactive for ${days} days will be permanently removed from the active database. Review your retention obligations and separate copies before enabling.`
            : 'Future automatic cleanup will stop. Already deleted data cannot be restored by turning this off.'
        }
        confirmLabel="Save policy"
        onConfirm={() => void save()}
      />
    </section>
  );
}
