import { useEffect, useState } from 'react';
import type { PlatformBudget } from '../shared/types';
import { useWorkspace } from '../lib/workspace';
import { api } from '../lib/api';
import { ErrorNotice, Field } from './ui';
export function PlatformBudgetSettings() {
  const { data } = useWorkspace();
  const [budget, setBudget] = useState<PlatformBudget>();
  const [limit, setLimit] = useState('100');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let active = true;
    api<PlatformBudget>('/platform/budget', data.company.id)
      .then((b) => {
        if (active) {
          setBudget(b);
          setLimit(String(b.limitUsd));
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [data.company.id]);
  async function save() {
    setBusy(true);
    setError('');
    try {
      const b = await api<PlatformBudget>(
        '/platform/budget',
        data.company.id,
        { limitUsd: Number(limit) },
        'PUT',
      );
      setBudget(b);
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card mb-6 space-y-4 p-5 sm:p-6">
      <h2 className="panel-title">Orderly-funded AI budget</h2>
      <ErrorNotice message={error} />
      <p className="text-sm leading-6 text-stone-500">
        Shared monthly safety limit across businesses using Orderly’s API keys. Each business also
        keeps its own limit. Client-funded keys do not consume this shared allowance. Estimates
        include conservative holds for interrupted requests; provider invoices can differ.
        Accounting months use UTC.
      </p>
      {budget && (
        <p className="text-sm">
          Estimated spend: ${budget.spentUsd.toFixed(2)} · Held for requests: $
          {budget.reservedUsd.toFixed(2)} · Limit: ${budget.limitUsd.toFixed(2)}
        </p>
      )}
      {budget && budget.spentUsd + budget.reservedUsd >= budget.limitUsd * 0.8 && (
        <p role="status" className="text-sm font-semibold text-amber-800">
          {budget.limitUsd === 0
            ? 'Platform-funded AI requests are disabled.'
            : 'At least 80% of the shared AI allowance is used or reserved. Review provider billing before increasing it.'}
        </p>
      )}
      <Field
        label="Shared monthly AI limit (USD)"
        hint="Only a platform administrator can change this. Enter 0 to stop new platform-funded model calls."
      >
        <input
          type="number"
          className="input max-w-xs"
          min="0"
          max="100000"
          step="0.01"
          value={limit}
          disabled={busy || !budget}
          onChange={(e) => {
            setLimit(e.target.value);
            setSaved(false);
          }}
        />
      </Field>
      <button
        className="btn"
        disabled={
          busy ||
          !budget ||
          limit === '' ||
          !Number.isFinite(Number(limit)) ||
          Number(limit) < 0 ||
          Number(limit) > 100000
        }
        onClick={() => void save()}
      >
        {busy ? 'Saving…' : 'Save shared limit'}
      </button>
      {saved && (
        <p role="status" className="text-sm text-green-800">
          Shared limit saved.
        </p>
      )}
    </section>
  );
}
