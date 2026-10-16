import { useEffect, useState } from 'react';
import type { RetentionStatus } from '../shared/types';
import { api } from '../lib/api';
import { dialogOpen, useAction, useWorkspace } from '../lib/workspace';
import { ActionButton, ConfirmDialog, ErrorNotice, Field } from './ui';

export function RetentionSettings() {
  const { data, notify } = useWorkspace();
  const { pending, run } = useAction();
  const [status, setStatus] = useState<RetentionStatus>();
  const [days, setDays] = useState('0');
  const [preview, setPreview] = useState<{ days: number; count: number }>();
  const [error, setError] = useState('');
  const [saveError, setSaveError] = useState('');
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
  const inspect = () =>
    run('preview', async () => {
      setError('');
      try {
        const r = await api<RetentionStatus>(
          `/privacy/retention?days=${encodeURIComponent(days)}`,
          data.company.id,
        );
        setPreview({ days: Number(days), count: r.eligibleConversations });
      } catch (e) {
        setError((e as Error).message);
      }
    });
  const save = () =>
    run('save', async () => {
      setSaveError('');
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
        notify(r.days ? `Retention policy saved: ${r.days} days.` : 'Automatic deletion turned off.');
      } catch (e) {
        // The dialog stays open and shows why; if it was closed meanwhile, notify instead.
        if (dialogOpen()) setSaveError((e as Error).message);
        else notify((e as Error).message, 'error');
      }
    });
  return (
    <section className="card mb-6 p-5 sm:p-6 space-y-4">
      <h2 className="panel-title">Automatic data retention</h2>
      <ErrorNotice message={error} />
      <p className="text-sm leading-6 text-stone-500">
        Off by default. Deletes inactive conversations and their finished orders, message history
        and related logs from Orderly. Unfinished orders, human handoffs and outstanding jobs are
        protected. Sheet copies, providers, exports and backups require separate handling.
      </p>
      <p
        className={
          !status
            ? 'skeleton inline-flex items-center rounded-full px-3.5 py-1.5 text-[13px] font-semibold text-stone-600'
            : status.days
              ? 'enter-pop inline-flex items-center rounded-full bg-success-700/10 px-3.5 py-1.5 text-[13px] font-semibold text-success-800'
              : 'enter-pop inline-flex items-center rounded-full bg-ink/[0.06] px-3.5 py-1.5 text-[13px] font-semibold text-stone-700'
        }
      >
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
          disabled={!status}
          onChange={(e) => {
            setDays(e.target.value);
            setPreview(undefined);
          }}
        />
      </Field>
      <ActionButton
        disabled={!status || !days}
        title={!days ? 'Enter a number of days first.' : undefined}
        loading={pending === 'preview'}
        loadingLabel="Checking…"
        onClick={() => void inspect()}
      >
        Preview policy
      </ActionButton>
      {/* A preview that arrived after the number changed belongs to another number. */}
      {preview && preview.days === Number(days) && (
        <div className="step-in space-y-3 rounded-2xl border border-ink/[0.06] bg-paper p-4 text-sm">
          <p className="font-medium text-ink">
            {preview.days === 0
              ? 'This will disable automatic deletion.'
              : `${preview.count}${preview.count === 100 ? '+' : ''} conversations currently qualify for the next batch. Counts can change as customers and staff act.`}
          </p>
          <button
            className="btn btn-primary"
            disabled={preview.days === status?.days}
            title={preview.days === status?.days ? 'This is already the saved policy.' : undefined}
            onClick={() => {
              setSaveError('');
              setConfirm(true);
            }}
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
        busy={pending === 'save'}
        busyLabel="Saving…"
        error={saveError}
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
