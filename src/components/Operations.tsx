import { useEffect, useState } from 'react';
import { BlockedNumbers } from './BlockedNumbers';
import { RetentionSettings } from './RetentionSettings';
import type { TeamMember, Job } from '../shared/types';
import { api } from '../lib/api';
import { useAction, useWorkspace } from '../lib/workspace';
import { label, shortDate } from '../lib/utils';
import {
  ActionButton,
  ConfirmDialog,
  CustomSelect,
  ErrorNotice,
  Field,
  PageHeading,
  Spinner,
  Status,
} from './ui';

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
  const { data, mutate, navigate } = useWorkspace();
  const { pending, run } = useAction();
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
            <ActionButton
              loading={pending === 'retry'}
              loadingLabel="Retrying…"
              onClick={() =>
                void run('retry', () =>
                  mutate('/jobs/retry', {}, undefined, {
                    success: 'Failed work queued to try again.',
                  }),
                ).catch(() => undefined)
              }
            >
              Retry failed work
            </ActionButton>
          )}
        </div>
        <p className="mt-2 text-sm text-stone-500">
          Failed sends and Sheet updates stay visible until retried. Fix the connection or provider
          quota before retrying. A Meta “sent” receipt is different from “delivered” or “read”.
        </p>
        <div className="stagger mt-4 space-y-2.5">
          {jobs.map((j) => (
            <div
              key={j.id}
              className="rounded-2xl border border-white bg-white/60 p-4 text-[13px] shadow-[0_12px_26px_-22px_rgb(14_6_4/0.45)]"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong className="font-semibold text-ink">{label(j.kind)}</strong>
                <Status value={j.status} />
              </div>
              <p className="mt-2 break-words text-red-700">{j.error}</p>
              <p className="mt-2 font-mono text-[11px] tracking-[0.02em] text-stone-500">
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
        <ol className="stagger mt-5 divide-y divide-ink/[0.05]">
          {data.traces.map((t) => (
            <li key={t.id} className="py-4 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong className="break-all font-semibold text-ink">{label(t.action)}</strong>
                <time className="rounded-full bg-ink/[0.05] px-2.5 py-0.5 font-mono text-[11px] text-stone-600">
                  {shortDate(t.createdAt)}
                </time>
              </div>
              <p className="mt-2 whitespace-pre-wrap break-words text-stone-600">{t.detail}</p>
              <p className="mt-2 break-all font-mono text-[11px] tracking-[0.02em] text-stone-500">
                {t.model && `Model: ${t.model} · `}
                {t.botVersion !== undefined && `Bot v${t.botVersion} · `}
                {t.durationMs !== undefined && `${t.durationMs} ms · `}
                {t.actorId && `By ${t.actorId}`}
              </p>
              {t.conversationId && (
                <button
                  className="mt-2.5 rounded-full bg-brand-500/10 px-3 py-1 text-xs font-semibold text-brand-800 transition-colors hover:bg-brand-500 hover:text-ink hover:shadow-[0_8px_16px_-8px_rgb(255_105_44/0.9)]"
                  onClick={() => navigate('inbox', t.conversationId)}
                >
                  Open conversation
                </button>
              )}
            </li>
          ))}
        </ol>
        {!data.traces.length && (
          <p className="mt-4 rounded-2xl border border-dashed border-ink/10 bg-paper/70 px-4 py-6 text-center text-sm text-stone-500">
            No events recorded yet.
          </p>
        )}
      </section>
    </>
  );
}

export function SecuritySettings() {
  const { data, auth, mutate, navigate, notify } = useWorkspace();
  const action = useAction();
  const pending = action.pending;
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [userId, setUserId] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'owner' | 'staff'>('staff');
  const [phone, setPhone] = useState('');
  const [ack, setAck] = useState(false);
  const [erase, setErase] = useState(false);
  const [error, setError] = useState('');
  const [eraseError, setEraseError] = useState('');
  const [factor, setFactor] = useState<{ id: string; qr: string }>();
  const [enrolled, setEnrolled] = useState<string>();
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const owner = data.role !== 'staff';
  // Changes here use quiet saves: this reports success and failure once, bottom right.
  const quiet = { quiet: true } as const;
  const run = (key: string, work: () => Promise<unknown>, success: string) =>
    action.run(key, async () => {
      try {
        await work();
        notify(success);
      } catch (e) {
        notify((e as Error).message, 'error');
      }
    });
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
      <ErrorNotice message={error} onDismiss={() => setError('')} />
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
              <ActionButton
                className="btn-primary"
                loading={pending === 'mfa-enroll'}
                loadingLabel="Preparing…"
                onClick={() =>
                  void run(
                    'mfa-enroll',
                    async () => {
                      const r = await auth.auth.mfa.enroll({
                        factorType: 'totp',
                        friendlyName: `Orderly ${new Date().toISOString()}`,
                      });
                      if (r.error) throw r.error;
                      setFactor({ id: r.data.id, qr: r.data.totp.qr_code });
                    },
                    'Scan the QR code in your authenticator, then verify a code.',
                  )
                }
              >
                Set up authenticator
              </ActionButton>
            )}
            {factor && (
              <div className="space-y-3 rounded-2xl border border-white bg-white/60 p-4 shadow-[0_14px_30px_-24px_rgb(14_6_4/0.45)]">
                <img
                  className="pop-in size-48 max-w-full rounded-2xl bg-white p-2 shadow-[0_0_0_1px_rgb(14_6_4/0.06),0_18px_36px_-24px_rgb(14_6_4/0.5)]"
                  src={factor.qr}
                  alt="Authenticator enrollment QR code"
                />
                <Field label="Six-digit authenticator code">
                  <input
                    className="input max-w-xs font-mono tracking-[0.3em]"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={code}
                    maxLength={6}
                    onChange={(e) => setCode(e.target.value)}
                  />
                </Field>
                <ActionButton
                  className="btn-primary"
                  loading={pending === 'mfa-verify'}
                  loadingLabel="Verifying…"
                  onClick={() =>
                    void run(
                      'mfa-verify',
                      async () => {
                        const r = await auth.auth.mfa.challengeAndVerify({
                          factorId: factor.id,
                          code,
                        });
                        if (r.error) throw r.error;
                        setEnrolled(factor.id);
                        setFactor(undefined);
                        setCode('');
                      },
                      'Authenticator protection enabled.',
                    )
                  }
                >
                  Verify and enable
                </ActionButton>
              </div>
            )}
            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                void run(
                  'password',
                  async () => {
                    const r = await auth.auth.updateUser({ password });
                    if (r.error) throw r.error;
                    setPassword('');
                  },
                  'Password updated.',
                );
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
              <ActionButton type="submit" loading={pending === 'password'} loadingLabel="Saving…">
                Change password
              </ActionButton>
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
                void run(
                  'invite',
                  async () => {
                    await mutate('/team/invite', { email, role }, undefined, quiet);
                    setEmail('');
                    await loadTeam();
                  },
                  'Invitation sent to the team member.',
                );
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
              <ActionButton
                type="submit"
                disabled={data.mode === 'demo'}
                title={data.mode === 'demo' ? 'Invitations need the hosted workspace.' : undefined}
                className="btn-primary self-end"
                loading={pending === 'invite'}
                loadingLabel="Sending…"
              >
                Send invitation
              </ActionButton>
            </form>
            <details className="group">
              <summary className="-ml-3 w-fit cursor-pointer rounded-full px-3 py-1.5 text-sm font-semibold text-stone-700 transition-colors select-none group-open:bg-ink/5 hover:bg-ink/5 hover:text-ink">
                Add an existing account
              </summary>
              <form
                className="step-in mt-3 flex flex-wrap items-end gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(
                    'add-member',
                    async () => {
                      await mutate(`/team/${encodeURIComponent(userId)}`, { role }, 'PUT', quiet);
                      setUserId('');
                      await loadTeam();
                    },
                    'Team access saved.',
                  );
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
                <ActionButton
                  type="submit"
                  loading={pending === 'add-member'}
                  loadingLabel="Saving…"
                >
                  Add as {role}
                </ActionButton>
              </form>
            </details>
            <ul className="stagger divide-y divide-ink/[0.05]">
              {members.map((m) => (
                <li
                  key={m.userId}
                  className="flex flex-wrap items-center justify-between gap-3 py-3"
                >
                  <code className="rounded-lg bg-ink/[0.04] px-2 py-1 font-mono text-xs break-all text-stone-700">
                    {m.userId}
                  </code>
                  <div className="flex flex-wrap items-center gap-2">
                    {pending === `role-${m.userId}` && (
                      <span className="flex items-center gap-1.5 text-xs text-stone-500">
                        <Spinner /> Saving…
                      </span>
                    )}
                    <CustomSelect
                      aria-label={`Role for ${m.userId}`}
                      value={m.role}
                      onChange={(v) =>
                        void run(
                          `role-${m.userId}`,
                          async () => {
                            await mutate(`/team/${m.userId}`, { role: v }, 'PUT', quiet);
                            await loadTeam();
                          },
                          'Role updated.',
                        )
                      }
                      options={[
                        { value: 'staff', label: 'Staff' },
                        { value: 'owner', label: 'Owner' },
                      ]}
                    />
                    <ActionButton
                      className="btn-quiet hover:bg-red-50 hover:text-red-700"
                      loading={pending === `remove-${m.userId}`}
                      loadingLabel="Removing…"
                      onClick={() =>
                        void run(
                          `remove-${m.userId}`,
                          async () => {
                            await mutate(`/team/${m.userId}`, undefined, 'DELETE', quiet);
                            await loadTeam();
                          },
                          'Access removed.',
                        )
                      }
                    >
                      Remove
                    </ActionButton>
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
            <ActionButton
              className="btn-ink"
              disabled={!phone}
              title={!phone ? 'Enter the customer’s phone number first.' : undefined}
              loading={pending === 'export'}
              loadingLabel="Preparing export…"
              onClick={() =>
                void run(
                  'export',
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
            </ActionButton>
            <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-white bg-white/50 p-3.5 text-sm leading-6 transition-colors hover:bg-white/80 has-checked:border-brand-500/35 has-checked:bg-brand-500/[0.07]">
              <input
                type="checkbox"
                className="mt-1 size-4 shrink-0 accent-brand-500 transition-transform active:scale-90"
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
              className="btn border-red-700/20 text-red-700 hover:border-red-700/35 hover:bg-red-50 hover:text-red-800"
              disabled={!phone || !ack || data.company.botEnabled}
              title={
                !phone
                  ? 'Enter the customer’s phone number first.'
                  : !ack
                    ? 'Tick the confirmation above first.'
                    : data.company.botEnabled
                      ? 'Pause automation in Bot settings first.'
                      : undefined
              }
              onClick={() => {
                setEraseError('');
                setErase(true);
              }}
            >
              Delete this customer’s data
            </button>
            <button className="btn ml-2" onClick={() => navigate('bot')}>
              Bot controls
            </button>
          </section>
        </>
      )}
      {/* Everyone on the team can block a number, so everyone can see and undo blocks. */}
      <BlockedNumbers />
      {owner && (
        <>
          <RetentionSettings />
          <section className="card p-5 sm:p-6">
            <h2 className="panel-title">Retention and support</h2>
            <p className="mt-3 text-sm leading-6 text-stone-500">
              Customer records are retained until an authorized deletion request or the business’s
              configured retention cleanup. No automatic deletion is enabled by default. Orderly’s
              operator and privacy contact is{' '}
              <a
                className="font-semibold break-all text-brand-700 underline decoration-brand-500/40 underline-offset-2 transition-colors hover:text-brand-800 hover:decoration-brand-500"
                href="mailto:waytogalaxy999@gmail.com"
              >
                waytogalaxy999@gmail.com
              </a>
              .
            </p>
            <p className="mt-3 text-sm">
              <a
                className="font-medium text-stone-700 underline decoration-ink/25 underline-offset-2 transition-colors hover:text-ink hover:decoration-brand-500"
                href="/privacy"
              >
                Privacy policy
              </a>{' '}
              ·{' '}
              <a
                className="font-medium text-stone-700 underline decoration-ink/25 underline-offset-2 transition-colors hover:text-ink hover:decoration-brand-500"
                href="/data-deletion"
              >
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
        busy={pending === 'erase'}
        busyLabel="Deleting…"
        error={eraseError}
        onConfirm={() => {
          setEraseError('');
          // The dialog shows a failure inline, where screen readers can reach it.
          void action.run('erase', async () => {
            try {
              await mutate(
                '/privacy/erase',
                { phone, externalCopiesAcknowledged: true },
                undefined,
                { dialog: true, success: 'Customer data removed from Orderly’s active database.' },
              );
              setErase(false);
            } catch (e) {
              setEraseError((e as Error).message);
            }
          });
        }}
      />
    </>
  );
}
