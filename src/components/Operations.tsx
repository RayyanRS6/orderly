import { useEffect, useState } from 'react';
import { RetentionSettings } from './RetentionSettings';
import type { TeamMember, Job } from '../shared/types';
import { api } from '../lib/api';
import { useWorkspace } from '../lib/workspace';
import { label, shortDate } from '../lib/utils';
import { ConfirmDialog, CustomSelect, ErrorNotice, Field, PageHeading, Status } from './ui';

export function download(name: string, value: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function Activity() {
  const { data, mutate, busy, navigate } = useWorkspace();
  const [jobs, setJobs] = useState<Job[]>(data.jobs ?? []);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api<{ jobs: Job[] }>('/activity', data.company.id)
      .then((r) => {
        if (active) setJobs(r.jobs);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [data.company.id, data.traces]);
  return (
    <>
      <PageHeading
        title="Activity & errors"
        description="Recorded actions, model usage and delivery work for this business."
      />
      <ErrorNotice message={error} />
      <section className="card mb-6 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="panel-title">
            Delivery work · {jobs.length}
            {jobs.length === 100 ? '+' : ''} open jobs
          </h2>
          {data.role !== 'staff' && (
            <button
              disabled={busy}
              className="btn"
              onClick={() => void mutate('/jobs/retry', {}).catch(() => {})}
            >
              Retry failed work
            </button>
          )}
        </div>
        <p className="mt-2 text-sm text-stone-500">
          Failed sends and Sheet updates stay visible until retried. Fix the connection or provider
          quota before retrying. A Meta “sent” receipt is different from “delivered” or “read”.
        </p>
        <div className="mt-4 space-y-3">
          {jobs.map((j) => (
            <div key={j.id} className="rounded-xl border border-white bg-white/50 p-4 text-[13px]">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong>{label(j.kind)}</strong>
                <Status value={j.status} />
              </div>
              <p className="mt-2 break-words text-red-700">{j.error}</p>
              <p className="mt-2 text-xs text-stone-500">
                Attempt {j.attempts} · Next attempt {shortDate(j.nextRunAt)}
              </p>
            </div>
          ))}
          {!jobs.length && <p className="text-sm text-stone-500">No pending or failed work.</p>}
        </div>
      </section>
      <section className="card p-5 sm:p-6">
        <h2 className="panel-title">Recent events</h2>
        <p className="mt-2 text-sm text-stone-500">
          These are recorded actions and outcomes. Model IDs, bot versions, token estimates and
          staff changes appear when available. Showing the latest {data.traces.length} events.
        </p>
        <ol className="mt-5 divide-y divide-ink/[0.05]">
          {data.traces.map((t) => (
            <li key={t.id} className="py-4 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong className="break-all">{label(t.action)}</strong>
                <time className="text-xs text-stone-500">{shortDate(t.createdAt)}</time>
              </div>
              <p className="mt-2 whitespace-pre-wrap break-words text-stone-600">{t.detail}</p>
              <p className="mt-2 break-all text-xs text-stone-500">
                {t.model && `Model: ${t.model} · `}
                {t.botVersion !== undefined && `Bot v${t.botVersion} · `}
                {t.durationMs !== undefined && `${t.durationMs} ms · `}
                {t.actorId && `By ${t.actorId}`}
              </p>
              {t.conversationId && (
                <button
                  className="mt-2 text-xs font-semibold text-brand-500 hover:text-brand-600"
                  onClick={() => navigate('inbox', t.conversationId)}
                >
                  Open conversation
                </button>
              )}
            </li>
          ))}
        </ol>
        {!data.traces.length && (
          <p className="mt-4 text-sm text-stone-500">No events recorded yet.</p>
        )}
      </section>
    </>
  );
}

export function SecuritySettings() {
  const { data, auth, mutate, busy, navigate } = useWorkspace();
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [userId, setUserId] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'owner' | 'staff'>('staff');
  const [phone, setPhone] = useState('');
  const [ack, setAck] = useState(false);
  const [erase, setErase] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [factor, setFactor] = useState<{ id: string; qr: string }>();
  const [enrolled, setEnrolled] = useState<string>();
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const owner = data.role !== 'staff';
  const run = async (work: () => Promise<unknown>, success: string) => {
    setError('');
    setNotice('');
    try {
      await work();
      setNotice(success);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const loadTeam = () => api<TeamMember[]>('/team', data.company.id).then(setMembers);
  useEffect(() => {
    if (owner) void loadTeam().catch((e) => setError(e.message));
    if (auth)
      void auth.auth.mfa
        .listFactors()
        .then((r) => setEnrolled(r.data?.totp.find((f) => f.status === 'verified')?.id));
  }, [data.company.id, auth]);
  return (
    <>
      <PageHeading
        title="Security & privacy"
        description="Protect your account, manage team access and respond to customer data requests."
      />
      <ErrorNotice message={error} />
      {notice && (
        <p
          role="status"
          className="mb-5 rounded-xl border border-success-700/15 bg-success-700/[0.07] p-4 text-[13px] text-success-800"
        >
          {notice}
        </p>
      )}
      <section className="card mb-6 p-5 sm:p-6 space-y-4">
        <h2 className="panel-title">Your account</h2>
        {auth ? (
          <>
            <p className="text-sm text-stone-500">
              Authenticator protection: <strong>{enrolled ? 'Enabled' : 'Not enabled'}</strong>.
              Once enabled, a verification code is required to access the workspace after password
              sign-in.
            </p>
            {!enrolled && !factor && (
              <button
                className="btn"
                onClick={() =>
                  void run(async () => {
                    const r = await auth.auth.mfa.enroll({
                      factorType: 'totp',
                      friendlyName: `Orderly ${new Date().toISOString()}`,
                    });
                    if (r.error) throw r.error;
                    setFactor({ id: r.data.id, qr: r.data.totp.qr_code });
                  }, 'Scan the QR code in your authenticator, then verify a code.')
                }
              >
                Set up authenticator
              </button>
            )}
            {factor && (
              <div className="space-y-3">
                <img
                  className="size-48 max-w-full"
                  src={factor.qr}
                  alt="Authenticator enrollment QR code"
                />
                <Field label="Six-digit authenticator code">
                  <input
                    className="input max-w-xs"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={code}
                    maxLength={6}
                    onChange={(e) => setCode(e.target.value)}
                  />
                </Field>
                <button
                  className="btn"
                  onClick={() =>
                    void run(async () => {
                      const r = await auth.auth.mfa.challengeAndVerify({
                        factorId: factor.id,
                        code,
                      });
                      if (r.error) throw r.error;
                      setEnrolled(factor.id);
                      setFactor(undefined);
                      setCode('');
                    }, 'Authenticator protection enabled.')
                  }
                >
                  Verify and enable
                </button>
              </div>
            )}
            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  const r = await auth.auth.updateUser({ password });
                  if (r.error) throw r.error;
                  setPassword('');
                }, 'Password updated.');
              }}
            >
              <Field label="New password">
                <input
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  required
                  className="input"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
              <button className="btn">Change password</button>
            </form>
            <button className="btn" onClick={() => void auth.auth.signOut({ scope: 'global' })}>
              Sign out all sessions
            </button>
          </>
        ) : (
          <p className="text-sm text-stone-500">
            Account security is available in the hosted workspace with Supabase sign-in.
          </p>
        )}
      </section>
      {owner && (
        <>
          <section className="card mb-6 p-5 sm:p-6 space-y-4">
            <h2 className="panel-title">Team access</h2>
            <p className="text-sm leading-6 text-stone-500">
              Owners manage settings, integrations and customer data. Staff handle orders and
              conversations. The last owner cannot be removed. Only invite people who should see
              this business’s customer data.
            </p>
            <form
              className="grid gap-3 sm:grid-cols-3"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await mutate('/team/invite', { email, role });
                  setEmail('');
                  await loadTeam();
                }, 'Invitation sent to the team member.');
              }}
            >
              <Field label="New member’s email">
                <input
                  type="email"
                  className="input"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </Field>
              <Field label="Role">
                <CustomSelect
                  value={role}
                  onChange={(v) => setRole(v as 'owner' | 'staff')}
                  options={[
                    { value: 'staff', label: 'Staff' },
                    { value: 'owner', label: 'Owner' },
                  ]}
                />
              </Field>
              <button disabled={busy || data.mode === 'demo'} className="btn self-end">
                Send invitation
              </button>
            </form>
            <details>
              <summary className="cursor-pointer text-sm font-medium">
                Add an existing account
              </summary>
              <form
                className="mt-3 flex flex-wrap items-end gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    await mutate(`/team/${encodeURIComponent(userId)}`, { role }, 'PUT');
                    setUserId('');
                    await loadTeam();
                  }, 'Team access saved.');
                }}
              >
                <Field label="Existing Supabase user ID">
                  <input
                    className="input"
                    required
                    value={userId}
                    onChange={(e) => setUserId(e.target.value)}
                    placeholder="Account UUID"
                  />
                </Field>
                <button disabled={busy} className="btn">
                  Add as {role}
                </button>
              </form>
            </details>
            <ul className="divide-y divide-ink/[0.05]">
              {members.map((m) => (
                <li
                  key={m.userId}
                  className="flex flex-wrap items-center justify-between gap-3 py-3"
                >
                  <code className="break-all text-xs">{m.userId}</code>
                  <div className="flex flex-wrap gap-2">
                    <CustomSelect
                      aria-label={`Role for ${m.userId}`}
                      value={m.role}
                      onChange={(v) =>
                        void run(async () => {
                          await mutate(`/team/${m.userId}`, { role: v }, 'PUT');
                          await loadTeam();
                        }, 'Role updated.')
                      }
                      options={[
                        { value: 'staff', label: 'Staff' },
                        { value: 'owner', label: 'Owner' },
                      ]}
                    />
                    <button
                      disabled={busy}
                      className="btn"
                      onClick={() =>
                        void run(async () => {
                          await mutate(`/team/${m.userId}`, undefined, 'DELETE');
                          await loadTeam();
                        }, 'Access removed.')
                      }
                    >
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
          <section className="card mb-6 p-5 sm:p-6 space-y-4">
            <h2 className="panel-title">Customer data requests</h2>
            <p className="text-sm leading-6 text-stone-500">
              Verify the requester’s identity and your retention obligations first. Exports include
              order records and message history. Deletion removes these records from Orderly’s
              active database; it retains anonymous usage totals and administrative audit events.
              Provider copies, downloaded exports, Google Sheets and backups require separate
              handling.
            </p>
            <Field
              label="Customer’s exact phone number"
              hint="Use the number shown in the Inbox, including its country code."
            >
              <input
                className="input max-w-md"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </Field>
            <button
              className="btn"
              disabled={!phone || busy}
              onClick={() =>
                void run(
                  async () =>
                    download(
                      'orderly-customer-export.json',
                      await api(
                        `/privacy/customer?phone=${encodeURIComponent(phone)}`,
                        data.company.id,
                      ),
                    ),
                  'Customer export downloaded.',
                )
              }
            >
              Export customer data
            </button>
            <label className="flex items-start gap-3 text-sm leading-6">
              <input
                type="checkbox"
                className="mt-1 size-4 shrink-0 accent-brand-500"
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
              />
              <span>
                I have verified the request and will handle copies in the connected Sheet, providers
                and backups separately.
              </span>
            </label>
            <p className="text-sm text-stone-500">
              Pause automation and wait for running jobs before deleting. New customer messages
              after deletion can create a new conversation.
            </p>
            <button
              className="btn text-red-700"
              disabled={!phone || !ack || busy || data.company.botEnabled}
              onClick={() => setErase(true)}
            >
              Delete this customer’s data
            </button>
            <button className="btn ml-2" onClick={() => navigate('bot')}>
              Bot controls
            </button>
          </section>
          <RetentionSettings />
          <section className="card p-5 sm:p-6">
            <h2 className="panel-title">Retention and support</h2>
            <p className="mt-3 text-sm leading-6 text-stone-500">
              Customer records are retained until an authorized deletion request or the business’s
              configured retention cleanup. No automatic deletion is enabled by default. Orderly’s
              operator and privacy contact is{' '}
              <a
                className="font-semibold text-brand-500 underline break-all"
                href="mailto:waytogalaxy999@gmail.com"
              >
                waytogalaxy999@gmail.com
              </a>
              .
            </p>
            <p className="mt-3 text-sm">
              <a className="underline" href="/privacy">
                Privacy policy
              </a>{' '}
              ·{' '}
              <a className="underline" href="/data-deletion">
                Deletion instructions
              </a>
            </p>
          </section>
        </>
      )}
      <ConfirmDialog
        open={erase}
        onOpenChange={setErase}
        title="Delete this customer’s data?"
        description={`This permanently removes active Orderly conversations and orders for ${phone}. Connected Sheets and provider records are separate.`}
        confirmLabel="Delete customer data"
        busy={busy}
        onConfirm={() =>
          void run(async () => {
            await mutate('/privacy/erase', { phone, externalCopiesAcknowledged: true });
            setErase(false);
          }, 'Customer data removed from Orderly’s active database.')
        }
      />
    </>
  );
}
