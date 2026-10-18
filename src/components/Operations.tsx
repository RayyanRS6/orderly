import { useEffect, useState } from 'react';
import { BlockedNumbers } from './BlockedNumbers';
import { RetentionSettings } from './RetentionSettings';
import type { AddMemberOutcome, TeamMember, Job } from '../shared/types';
import { api, ApiError } from '../lib/api';
import { useAction, useWorkspace } from '../lib/workspace';
import { label, shortDate } from '../lib/utils';
import { addedMessage, describeTeamChange, personName, type TeamChange } from '../lib/people';
import { describeTrace } from '../shared/explain';
import { supportEmail } from './Public';
import {
  ActionButton,
  Badge,
  ConfirmDialog,
  CustomSelect,
  ErrorNotice,
  Field,
  PageHeading,
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
/** What export and deletion say when no chat or order matches the number. */
export const NO_CUSTOMER_RECORDS =
  'No records found for this number. Copy the number exactly as shown in the Inbox.';
/** What export and deletion from a chat say when that chat is gone (the server's words). */
export const NO_CHAT_RECORDS = 'No records found for this chat. It may have been deleted already.';
/** The success note for a deletion, with what the server really removed. */
export const erasedMessage = (conversations: number) =>
  `Removed ${conversations} ${conversations === 1 ? 'conversation' : 'conversations'} and their orders from Orderly’s active database.`;
/** The success note for an export, with what the file really holds. */
export const exportedMessage = (conversations: number, orders: number) =>
  `Customer export downloaded: ${conversations} ${conversations === 1 ? 'conversation' : 'conversations'} and ${orders} ${orders === 1 ? 'order' : 'orders'}.`;
/** Event and job codes as words: 'whatsapp.accepted' reads 'WhatsApp accepted'. */
const codeLabel = (code: string) =>
  label(code.replaceAll('.', ' '))
    .replace(/\bwhatsapp\b/gi, 'WhatsApp')
    .replace(/\bai\b/gi, 'AI');
export function Activity() {
  const { data, mutate, navigate, notify } = useWorkspace();
  const { pending, run } = useAction();
  // Undefined until a list arrives: the workspace's first load carries no jobs.
  const [jobs, setJobs] = useState<Job[] | undefined>(data.jobs);
  const [error, setError] = useState('');
  useEffect(() => {
    // The workspace's own refresh already brought them: asking again would only repeat it.
    if (data.jobs) return;
    let active = true;
    api<{ jobs: Job[] }>('/activity', data.company.id)
      .then((r) => {
        if (active) {
          setJobs(r.jobs);
          setError('');
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [data.company.id]);
  // The workspace's 15-second refresh brings jobs; a reload after a save doesn't, so the
  // last list stays until the next one.
  useEffect(() => {
    if (!data.jobs) return;
    setJobs(data.jobs);
    setError('');
  }, [data.jobs]);
  const events = data.traces.length;
  return (
    <>
      <PageHeading
        title="Activity & errors"
        description="Recorded actions, model usage and delivery work for this business."
      />
      <div className="mb-4 empty:hidden">
        <ErrorNotice message={error} onDismiss={() => setError('')} />
      </div>
      <section className="card mb-6 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="panel-title">
            Delivery work
            {jobs &&
              ` · ${jobs.length}${jobs.length === 100 ? '+' : ''} ${jobs.length === 1 ? 'open job' : 'open jobs'}`}
          </h2>
          {data.role !== 'staff' && (
            <ActionButton
              loading={pending === 'retry'}
              loadingLabel="Retrying…"
              onClick={() =>
                void run('retry', async () => {
                  const r = await mutate<{ queued: number }>('/jobs/retry', {});
                  notify(
                    r.queued ? 'Failed work queued to try again.' : 'Nothing waiting to retry.',
                    r.queued ? 'success' : 'info',
                  );
                  // The reload after a save carries no jobs, so ask for them again.
                  const fresh = await api<{ jobs: Job[] }>('/activity', data.company.id);
                  setJobs(fresh.jobs);
                  setError('');
                }).catch(() => undefined)
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
          {jobs?.map((j) => (
            <div
              key={j.id}
              className="rounded-2xl border border-white bg-white/60 p-4 text-[13px] shadow-[0_12px_26px_-22px_rgb(14_6_4/0.45)]"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong className="font-semibold text-ink">{codeLabel(j.kind)}</strong>
                <Status value={j.status} />
              </div>
              <p className="mt-2 break-words text-red-700">{j.error}</p>
              <p className="mt-2 font-mono text-[11px] tracking-[0.02em] text-stone-500">
                Attempt {j.attempts} · Next attempt {shortDate(j.nextRunAt)}
              </p>
            </div>
          ))}
          {jobs?.length === 0 && (
            <p className="rounded-2xl border border-dashed border-ink/10 bg-paper/70 px-4 py-6 text-center text-sm text-stone-500">
              No pending or failed work.
            </p>
          )}
          {!jobs && !error && <p className="text-sm text-stone-500">Loading delivery work…</p>}
        </div>
      </section>
      <section className="card p-5 sm:p-6">
        <h2 className="panel-title">Recent events</h2>
        <p className="mt-2 text-sm text-stone-500">
          These are recorded actions and outcomes. Model IDs, bot versions, token estimates and
          staff changes appear when available. Showing the latest {events}{' '}
          {events === 1 ? 'event' : 'events'}.
        </p>
        <ol className="stagger mt-5 divide-y divide-ink/[0.05]">
          {data.traces.map((t) => {
            const meta = [
              t.model && `Model: ${t.model}`,
              t.botVersion !== undefined && `Bot v${t.botVersion}`,
              t.durationMs !== undefined && `${t.durationMs} ms`,
              t.actorId && `By ${t.actorId}`,
            ]
              .filter(Boolean)
              .join(' · ');
            return (
              <li key={t.id} className="py-4 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  {/* Wraps between words; only a long code or path breaks inside a word. */}
                  <strong className="break-words font-semibold text-ink">
                    {describeTrace(t.action, t.code) ?? codeLabel(t.action)}
                  </strong>
                  <time
                    dateTime={t.createdAt}
                    className="rounded-full bg-ink/[0.05] px-2.5 py-0.5 font-mono text-[11px] text-stone-600"
                  >
                    {shortDate(t.createdAt)}
                  </time>
                </div>
                <p className="mt-2 whitespace-pre-wrap break-words text-stone-600">{t.detail}</p>
                {meta && (
                  <p className="mt-2 break-all font-mono text-[11px] tracking-[0.02em] text-stone-500">
                    {meta}
                  </p>
                )}
                {t.conversationId && (
                  <button
                    className="mt-2.5 inline-flex items-center rounded-full bg-brand-500/10 px-3 py-1 text-xs font-semibold text-brand-800 transition-colors hover:bg-brand-500 hover:text-ink hover:shadow-[0_8px_16px_-8px_rgb(255_105_44/0.9)] max-md:min-h-9"
                    onClick={() => navigate('inbox', t.conversationId)}
                  >
                    Open conversation
                  </button>
                )}
              </li>
            );
          })}
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

/** Owners' team list: add people by email, change roles and remove access, each confirmed. */
function TeamAccess() {
  const { data, mutate, notify } = useWorkspace();
  const action = useAction();
  const pending = action.pending;
  const [members, setMembers] = useState<TeamMember[]>();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'owner' | 'staff'>('staff');
  const [error, setError] = useState('');
  // Kept while the dialog closes, so its text doesn't vanish mid-animation.
  const [teamChange, setTeamChange] = useState<TeamChange>();
  const [confirming, setConfirming] = useState(false);
  const [teamError, setTeamError] = useState('');
  const [teamFailed, setTeamFailed] = useState(false);
  const loadTeam = () =>
    api<TeamMember[]>('/team', data.company.id).then((list) => {
      setMembers(list);
      setTeamFailed(false);
    });
  useEffect(() => {
    void loadTeam().catch((e) => {
      setTeamFailed(true);
      setError(e.message);
    });
  }, [data.company.id]);
  const ask = (change: TeamChange) => {
    // One change at a time: a running one must finish against the person it was asked for.
    if (pending === 'team-change') return;
    setTeamError('');
    setTeamChange(change);
    setConfirming(true);
  };
  const copy = teamChange && describeTeamChange(teamChange, data.company.name);
  const roles = [
    { value: 'staff', label: 'Staff' },
    { value: 'owner', label: 'Owner' },
  ];
  return (
    <section className="card mb-6 p-5 sm:p-6 space-y-4">
      <h2 className="panel-title">Team access</h2>
      <ErrorNotice message={error} onDismiss={() => setError('')} />
      <p className="text-sm leading-6 text-stone-500">
        Owners manage settings, connections and the team. Staff handle orders and chats. Every
        business keeps at least one owner. The Orderly admin can also open this business to help.
        Only add people who should see this business’s customers.
      </p>
      <h3 className="eyebrow">Add to team</h3>
      <form
        className="grid gap-3 sm:grid-cols-3"
        onSubmit={(e) => {
          e.preventDefault();
          const added = email.trim();
          // Quiet save: this reports success and failure once, bottom right.
          void action.run('invite', async () => {
            try {
              const r = await mutate<{ outcome?: AddMemberOutcome }>(
                '/team/invite',
                { email: added, role },
                undefined,
                { quiet: true },
              );
              notify(addedMessage(added, r.outcome));
              setEmail('');
              await loadTeam();
            } catch (e) {
              notify((e as Error).message, 'error');
            }
          });
        }}
      >
        <Field label="Their email">
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
            options={roles}
          />
        </Field>
        <ActionButton
          type="submit"
          className="btn-primary self-end"
          loading={pending === 'invite'}
          loadingLabel="Adding…"
        >
          Add person
        </ActionButton>
      </form>
      {!members && !error && !teamFailed && <p className="text-sm text-stone-500">Loading team…</p>}
      <ul className="stagger divide-y divide-ink/[0.05]">
        {members?.map((m) => (
          <li key={m.userId} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink break-all">{personName(m)}</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                <Badge tone={m.role === 'owner' ? 'amber' : 'neutral'}>{label(m.role)}</Badge>
                {m.you && <Badge tone="green">You</Badge>}
                {m.waiting && <Badge>Hasn’t signed in yet</Badge>}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {/* A fixed width keeps Remove beside the select. */}
              <div className="w-36 shrink-0">
                <CustomSelect
                  aria-label={`Role for ${personName(m)}`}
                  value={m.role}
                  disabled={m.you}
                  onChange={(v) => {
                    if (v !== m.role)
                      ask({ kind: 'role', member: m, role: v as 'owner' | 'staff' });
                  }}
                  options={roles}
                />
              </div>
              {!m.you && (
                <button
                  type="button"
                  className="btn btn-quiet hover:bg-red-50 hover:text-red-700"
                  aria-label={`Remove ${personName(m)}`}
                  onClick={() => ask({ kind: 'remove', member: m })}
                >
                  Remove
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          // Stays open until a running change finishes, so its result lands on this person.
          if (!open && pending === 'team-change') return;
          setConfirming(open);
        }}
        title={copy?.title ?? ''}
        description={copy?.description ?? ''}
        confirmLabel={copy?.confirmLabel}
        busyLabel={copy?.busyLabel}
        tone={copy?.tone}
        busy={pending === 'team-change'}
        error={teamError}
        onConfirm={() => {
          const change = teamChange;
          if (!change) return;
          setTeamError('');
          // The dialog shows a failure inline, where screen readers can reach it.
          void action.run('team-change', async () => {
            try {
              await mutate(
                `/team/${encodeURIComponent(change.member.userId)}`,
                change.kind === 'role' ? { role: change.role } : undefined,
                change.kind === 'role' ? 'PUT' : 'DELETE',
                {
                  dialog: true,
                  success: change.kind === 'role' ? 'Role updated.' : 'Access removed.',
                },
              );
              setConfirming(false);
            } catch (e) {
              setTeamError((e as Error).message);
            } finally {
              await loadTeam().catch(() => undefined);
            }
          });
        }}
      />
    </section>
  );
}

export function SecuritySettings() {
  const { data, auth, mutate, navigate, notify } = useWorkspace();
  const action = useAction();
  const pending = action.pending;
  const [phone, setPhone] = useState('');
  const [ack, setAck] = useState(false);
  const [erase, setErase] = useState(false);
  const [eraseError, setEraseError] = useState('');
  const [factor, setFactor] = useState<{ id: string; qr: string; secret: string }>();
  // Undefined while checking, null when no authenticator is enabled.
  const [enrolled, setEnrolled] = useState<string | null>();
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const owner = data.role !== 'staff';
  // The server's own words (404); older servers answered with empty results instead.
  const noMatch = NO_CUSTOMER_RECORDS;
  // Changes here report success and failure once, bottom right. Work can answer with its
  // own note instead, such as when nothing matched.
  const run = (key: string, work: () => Promise<string | void>, success: string) =>
    action.run(key, async () => {
      try {
        const note = await work();
        if (note) notify(note, 'info');
        else notify(success);
      } catch (e) {
        notify((e as Error).message, 'error');
      }
    });
  useEffect(() => {
    if (auth)
      void auth.auth.mfa
        .listFactors()
        .then((r) => {
          if (r.error) throw r.error;
          setEnrolled(r.data.totp.find((f) => f.status === 'verified')?.id ?? null);
        })
        .catch(() => {
          setEnrolled(null);
          notify('Couldn’t check authenticator protection. Reload to try again.', 'error');
        });
  }, [data.company.id, auth]);
  return (
    <>
      <PageHeading
        title="Security & privacy"
        description="Protect your account, manage team access and respond to customer data requests."
      />
      <section className="card mb-6 p-5 sm:p-6 space-y-4">
        <h2 className="panel-title">Your account</h2>
        {auth ? (
          <>
            <p className="text-sm text-stone-500">
              Authenticator protection:{' '}
              <strong>
                {enrolled === undefined ? 'Checking…' : enrolled ? 'Enabled' : 'Not enabled'}
              </strong>
              . Once enabled, a verification code is required to access the workspace after password
              sign-in.
            </p>
            {enrolled === null && !factor && (
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
                      setFactor({
                        id: r.data.id,
                        qr: r.data.totp.qr_code,
                        secret: r.data.totp.secret,
                      });
                    },
                    'Scan the QR code or enter the key in your authenticator, then verify a code.',
                  )
                }
              >
                Set up authenticator
              </ActionButton>
            )}
            {factor && (
              <form
                className="space-y-3 rounded-2xl border border-white bg-white/60 p-4 shadow-[0_14px_30px_-24px_rgb(14_6_4/0.45)]"
                onSubmit={(e) => {
                  e.preventDefault();
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
                  );
                }}
              >
                <img
                  className="pop-in size-48 max-w-full rounded-2xl bg-white p-2 shadow-[0_0_0_1px_rgb(14_6_4/0.06),0_18px_36px_-24px_rgb(14_6_4/0.5)]"
                  src={factor.qr}
                  alt="Authenticator enrollment QR code"
                />
                {/* For an authenticator on this same phone, or a screen reader. */}
                <div>
                  <p className="field-label">Or enter this key</p>
                  <p className="font-mono text-[13px] break-all select-all text-stone-700">
                    {factor.secret}
                  </p>
                </div>
                <Field label="Six-digit authenticator code">
                  <input
                    className="input max-w-xs font-mono tracking-[0.3em]"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="\d{6}"
                    value={code}
                    maxLength={6}
                    onChange={(e) => setCode(e.target.value)}
                  />
                </Field>
                <ActionButton
                  type="submit"
                  className="btn-primary"
                  disabled={code.length !== 6}
                  loading={pending === 'mfa-verify'}
                  loadingLabel="Verifying…"
                >
                  Verify and enable
                </ActionButton>
              </form>
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
          <TeamAccess />
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
              disabled={!phone.trim()}
              title={!phone.trim() ? 'Enter the customer’s phone number first.' : undefined}
              loading={pending === 'export'}
              loadingLabel="Preparing export…"
              onClick={() =>
                void run(
                  'export',
                  async () => {
                    let found: { conversations: unknown[]; orders: unknown[] };
                    try {
                      found = await api<typeof found>(
                        `/privacy/customer?phone=${encodeURIComponent(phone.trim())}`,
                        data.company.id,
                      );
                    } catch (e) {
                      // Nothing matched: a note, like the empty answer from older servers.
                      if (e instanceof ApiError && e.status === 404) return e.message;
                      throw e;
                    }
                    // An empty file would look like a finished export.
                    if (!found.conversations.length && !found.orders.length) return noMatch;
                    download('orderly-customer-export.json', found);
                  },
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
            <div className="flex flex-wrap gap-2">
              <button
                className="btn border-red-700/20 text-red-700 hover:border-red-700/35 hover:bg-red-50 hover:text-red-800"
                disabled={!phone.trim() || !ack || data.company.botEnabled}
                title={
                  !phone.trim()
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
              <button className="btn" onClick={() => navigate('bot')}>
                Bot controls
              </button>
            </div>
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
                href={`mailto:${supportEmail}`}
              >
                {supportEmail}
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
        description={`This permanently removes active Orderly conversations and orders for ${phone.trim()}. Connected Sheets and provider records are separate.`}
        confirmLabel="Delete customer data"
        busy={pending === 'erase'}
        busyLabel="Deleting…"
        error={eraseError}
        onConfirm={() => {
          setEraseError('');
          // The dialog shows a failure inline, where screen readers can reach it.
          void action.run('erase', async () => {
            try {
              const r = await mutate<{ deleted: number }>(
                '/privacy/erase',
                { phone: phone.trim(), externalCopiesAcknowledged: true },
                undefined,
                { dialog: true },
              );
              setErase(false);
              // Older servers answer 0 instead of 404 when nothing was there to remove.
              if (r.deleted) notify(erasedMessage(r.deleted));
              else notify(noMatch, 'info');
            } catch (e) {
              // Also "No records found…" (404): the dialog stays open, so the number can be fixed.
              setEraseError((e as Error).message);
            }
          });
        }}
      />
    </>
  );
}
