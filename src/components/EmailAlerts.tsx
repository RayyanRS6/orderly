import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useWorkspace } from '../lib/workspace';
import type { AlertPreferences } from '../shared/types';
import { ErrorNotice, Field } from './ui';
export function EmailAlerts() {
  const { data } = useWorkspace();
  const [preferences, setPreferences] = useState<AlertPreferences>();
  const [enabled, setEnabled] = useState(false);
  const [minutes, setMinutes] = useState(10);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    api<AlertPreferences>('/notifications', data.company.id)
      .then((p) => {
        if (active) {
          setPreferences(p);
          setEnabled(p.enabled);
          setMinutes(p.responseMinutes);
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
    setMessage('');
    try {
      const p = await api<AlertPreferences>(
        '/notifications',
        data.company.id,
        { enabled, responseMinutes: minutes },
        'PUT',
      );
      setPreferences(p);
      setMessage(
        p.enabled
          ? 'Email alerts enabled for your verified account email.'
          : 'Email alerts turned off.',
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="mt-5 space-y-3 border-t border-ink/10 pt-4">
      <h3 className="font-semibold">Email escalation</h3>
      <ErrorNotice message={error} />
      <p className="text-xs leading-5 text-stone-500">
        Opt in for this business using your verified Orderly account email. A scheduler checks every
        five minutes and queues at most one reminder per hour while overdue work or an 80% AI budget
        warning remains. Notifications contain no customer details. Mail-provider acceptance does
        not guarantee inbox delivery.
      </p>
      {preferences && !preferences.available && (
        <p className="text-xs text-amber-800">
          Not configured yet. Orderly needs a mail-service key and verified sending address. Browser
          and in-app alerts remain available.
        </p>
      )}
      {preferences && !preferences.emailVerified && (
        <p className="text-xs text-stone-500">A verified hosted account email is required.</p>
      )}
      <label className="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          className="mt-1 accent-brand-500"
          checked={enabled}
          disabled={
            busy ||
            !preferences ||
            (!preferences.enabled && (!preferences.available || !preferences.emailVerified))
          }
          onChange={(e) => {
            setEnabled(e.target.checked);
            setMessage('');
          }}
        />
        <span>Send email alerts to my verified account</span>
      </label>
      <Field
        label="Alert when work waits this many minutes"
        hint="5–120 minutes. Budget warnings do not wait for this threshold."
      >
        <input
          type="number"
          className="input max-w-32"
          min="5"
          max="120"
          value={minutes}
          disabled={busy || !preferences}
          onChange={(e) => {
            setMinutes(Number(e.target.value));
            setMessage('');
          }}
        />
      </Field>
      <button
        className="btn"
        disabled={
          busy ||
          !preferences ||
          (!preferences.available && enabled) ||
          (!preferences.enabled && !enabled) ||
          minutes < 5 ||
          minutes > 120
        }
        onClick={() => void save()}
      >
        {busy ? 'Saving…' : 'Save email preferences'}
      </button>
      {message && (
        <p role="status" className="text-xs text-green-800">
          {message}
        </p>
      )}
    </section>
  );
}
