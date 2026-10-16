import { useEffect, useMemo, useRef, useState } from 'react';
import type { AddMemberOutcome, PeopleAccount, PeopleDirectory } from '../shared/types';
import { api } from '../lib/api';
import { useAction, useWorkspace } from '../lib/workspace';
import { label } from '../lib/utils';
import { go, workspacePath } from '../lib/routes';
import {
  addedMessage,
  changeRequest,
  describeChange,
  groupPeople,
  lastSeen,
  personName,
  type PeopleChange,
} from '../lib/people';
import {
  ActionButton,
  Badge,
  ConfirmDialog,
  CustomSelect,
  ErrorNotice,
  Field,
  PageHeading,
} from './ui';

const roles = [
  { value: 'staff', label: 'Staff' },
  { value: 'owner', label: 'Owner' },
];
const note =
  'rounded-2xl border border-dashed border-ink/10 bg-paper/70 px-4 py-3 text-sm text-stone-500';

/** The platform admin's view of everyone who can sign in, by business. Loaded on demand. */
export function People() {
  const { data, mutate, notify } = useWorkspace();
  const { pending, run } = useAction();
  const [directory, setDirectory] = useState<PeopleDirectory>();
  const [error, setError] = useState('');
  // Bumped after each change, so the directory loads again.
  const [loads, setLoads] = useState(0);
  const [search, setSearch] = useState('');
  const [email, setEmail] = useState('');
  const [companyId, setCompanyId] = useState(data.company.id);
  const [role, setRole] = useState<'owner' | 'staff'>('staff');
  // Kept while the dialog closes, so its text doesn't vanish mid-animation.
  const [change, setChange] = useState<PeopleChange>();
  const [confirming, setConfirming] = useState(false);
  const [changeError, setChangeError] = useState('');
  const addCard = useRef<HTMLElement>(null);
  const groups = useMemo(() => directory && groupPeople(directory, search), [directory, search]);
  useEffect(() => {
    if (data.role !== 'admin') return;
    let active = true;
    api<PeopleDirectory>('/admin/people', data.company.id)
      .then((r) => {
        if (active) {
          setDirectory(r);
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

  if (data.role !== 'admin')
    return (
      <section className="card p-5 sm:p-6">
        <h1 className="panel-title">People</h1>
        <p className="mt-2 text-sm text-stone-500">
          This page is only for the Orderly admin. Ask them if someone needs to be added or removed.
        </p>
      </section>
    );

  const ask = (next: PeopleChange) => {
    setChangeError('');
    setChange(next);
    setConfirming(true);
  };
  const copy = change && directory && describeChange(change, directory);
  const deleteButton = (person: PeopleAccount) =>
    !person.you &&
    !person.admin && (
      <button
        type="button"
        className="btn btn-quiet hover:bg-red-50 hover:text-red-700"
        disabled={!directory?.canDeleteAccounts}
        title={
          directory?.canDeleteAccounts
            ? undefined
            : 'Turn on authenticator protection in Security & privacy first.'
        }
        onClick={() => ask({ kind: 'delete', person })}
      >
        Delete account
      </button>
    );
  const details = (person: PeopleAccount, memberRole?: 'owner' | 'staff') => (
    <div className="min-w-0">
      <p className="text-sm font-semibold text-ink break-all">{personName(person)}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {memberRole && (
          <Badge tone={memberRole === 'owner' ? 'amber' : 'neutral'}>{label(memberRole)}</Badge>
        )}
        {person.you && <Badge tone="green">You</Badge>}
        <span className="text-xs text-stone-500">{lastSeen(person)}</span>
      </div>
    </div>
  );

  return (
    <>
      <PageHeading
        title="People"
        description="Everyone who can sign in to Orderly, by business. Only you can see this page."
      />
      <div className="mb-6 space-y-3 empty:hidden">
        <ErrorNotice message={error} onDismiss={() => setError('')} />
        {directory?.emailsUnavailable && (
          <p className={note}>
            Emails couldn’t be loaded from Supabase right now, so people show by account ID.
          </p>
        )}
        {directory && !directory.canDeleteAccounts && (
          <p className={note}>
            To delete accounts, turn on authenticator protection in Security & privacy first.
          </p>
        )}
      </div>
      <section ref={addCard} className="card mb-6 p-5 sm:p-6 space-y-4">
        <h2 className="panel-title">Add someone to a business</h2>
        <form
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
          onSubmit={(e) => {
            e.preventDefault();
            const added = email.trim();
            void run('add', async () => {
              try {
                const r = await mutate<{ outcome?: AddMemberOutcome }>(
                  `/admin/businesses/${encodeURIComponent(companyId)}/members`,
                  { email: added, role },
                  undefined,
                  { quiet: true },
                );
                notify(addedMessage(added, r.outcome));
                setEmail('');
              } catch (e) {
                notify((e as Error).message, 'error');
              } finally {
                setLoads((n) => n + 1);
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
          <Field label="Business">
            <CustomSelect
              value={companyId}
              onChange={setCompanyId}
              options={(directory?.businesses ?? data.companies).map((b) => ({
                value: b.id,
                label: b.name,
              }))}
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
            loading={pending === 'add'}
            loadingLabel="Adding…"
          >
            Add person
          </ActionButton>
        </form>
      </section>
      <input
        type="search"
        className="input mb-6"
        aria-label="Search people"
        placeholder="Search by email, account ID or business"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {!directory && !error && <p className="text-sm text-stone-500">Loading people…</p>}
      {groups && (
        <>
          <div className="stagger space-y-6">
            {groups.businesses.map(({ business, members, total }) => (
              <section key={business.id} className="card p-5 sm:p-6">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="panel-title break-words">{business.name}</h2>
                    <p className="mt-1 text-sm text-stone-500">
                      {total} {total === 1 ? 'person' : 'people'}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="btn btn-quiet"
                    onClick={() => go(workspacePath(business.slug, 'security'))}
                  >
                    Open
                  </button>
                </div>
                {!members.length && (
                  <p className="mt-4 text-sm text-stone-500">Nobody has been added yet.</p>
                )}
                <ul className="mt-3 divide-y divide-ink/[0.05]">
                  {members.map(({ person, role: memberRole }) => (
                    <li
                      key={person.userId}
                      className="flex flex-wrap items-center justify-between gap-3 py-3"
                    >
                      {details(person, memberRole)}
                      <div className="flex flex-wrap items-center gap-2">
                        <CustomSelect
                          aria-label={`Role for ${personName(person)} at ${business.name}`}
                          value={memberRole}
                          disabled={person.you}
                          onChange={(v) => {
                            if (v !== memberRole)
                              ask({
                                kind: 'role',
                                person,
                                companyId: business.id,
                                role: v as 'owner' | 'staff',
                              });
                          }}
                          options={roles}
                        />
                        {!person.you && (
                          <button
                            type="button"
                            className="btn btn-quiet"
                            onClick={() => ask({ kind: 'remove', person, companyId: business.id })}
                          >
                            Remove
                          </button>
                        )}
                        {deleteButton(person)}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
          {!!groups.unassigned.length && (
            <section className="card mt-6 p-5 sm:p-6">
              <h2 className="panel-title">Not in any business yet</h2>
              <p className="mt-2 text-sm text-stone-500">
                These accounts can sign in but can’t see any business.
              </p>
              <ul className="mt-3 divide-y divide-ink/[0.05]">
                {groups.unassigned.map((person) => (
                  <li
                    key={person.userId}
                    className="flex flex-wrap items-center justify-between gap-3 py-3"
                  >
                    {details(person)}
                    <div className="flex flex-wrap items-center gap-2">
                      {person.email && (
                        <button
                          type="button"
                          className="btn btn-quiet"
                          onClick={() => {
                            setEmail(person.email ?? '');
                            addCard.current?.scrollIntoView({ block: 'start' });
                          }}
                        >
                          Add to a business
                        </button>
                      )}
                      {deleteButton(person)}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {!!groups.admins.length && (
            <section className="card mt-6 p-5 sm:p-6">
              <h2 className="panel-title">Platform admins</h2>
              <p className="mt-2 text-sm text-stone-500">
                Admins can see every business. Add or remove admins in Supabase.
              </p>
              <ul className="mt-3 divide-y divide-ink/[0.05]">
                {groups.admins.map((person) => (
                  <li key={person.userId} className="py-3">
                    {details(person)}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {search.trim() &&
            !groups.businesses.length &&
            !groups.unassigned.length &&
            !groups.admins.length && <p className={note}>Nobody matches “{search.trim()}”.</p>}
        </>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={copy?.title ?? ''}
        description={copy?.description ?? ''}
        confirmLabel={copy?.confirmLabel}
        busyLabel={copy?.busyLabel}
        tone={copy?.tone}
        busy={pending === 'change'}
        error={changeError}
        onConfirm={() => {
          if (!change) return;
          const request = changeRequest(change);
          setChangeError('');
          // The dialog shows a failure inline, where screen readers can reach it.
          void run('change', async () => {
            try {
              await mutate(request.path, request.body, request.method, {
                dialog: true,
                success: request.success,
              });
              setConfirming(false);
            } catch (e) {
              setChangeError((e as Error).message);
            } finally {
              setLoads((n) => n + 1);
            }
          });
        }}
      />
    </>
  );
}
