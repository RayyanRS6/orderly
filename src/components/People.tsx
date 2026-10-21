import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AddMemberOutcome,
  DeleteBusinessResult,
  PeopleAccount,
  PeopleDirectory,
} from '../shared/types';
import { api } from '../lib/api';
import { useAction, useWorkspace } from '../lib/workspace';
import { label } from '../lib/utils';
import { go, workspacePath } from '../lib/routes';
import {
  addedMessage,
  businessDeletedMessage,
  businessNameMatches,
  changeRequest,
  deleteBusinessBlocked,
  deleteBusinessCopy,
  deleteBusinessRequest,
  deleteBusinessWait,
  describeChange,
  groupPeople,
  lastSeen,
  LINKED_DEVICE_NOTES,
  linkedDeviceCopy,
  linkedDeviceOn,
  linkedDeviceRequest,
  linkedDeviceState,
  personName,
  type LinkedDeviceState,
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

/**
 * The admin's linked-phone switch for one business. Ticked whenever a new pairing is possible,
 * including for a business allowed only because it already used a linked phone, so unticking
 * stops pairing in one step. Where that couldn't be checked, Stop pairing is offered directly.
 */
export function LinkedDeviceSwitch({
  state,
  pending,
  onAsk,
}: {
  state: LinkedDeviceState;
  /** A linked-phone change is being saved. */
  pending: boolean;
  /** Opens the confirmation for allowing (true) or stopping (false) new pairings. */
  onAsk: (allowed: boolean) => void;
}) {
  const on = linkedDeviceOn(state);
  return (
    <div className="mt-3 flex flex-wrap items-start gap-2">
      <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-3 rounded-2xl border border-ink/[0.06] bg-paper px-4 py-3 text-sm leading-6 transition-colors has-[:checked]:border-brand-500/25 has-[:checked]:bg-brand-50">
        <input
          className="mt-1 size-4 shrink-0 accent-brand-500"
          type="checkbox"
          checked={on}
          disabled={pending}
          onChange={() => onAsk(!on)}
        />
        <span>
          <span className="font-semibold text-ink">Allow linked-phone pairing</span>
          {state === 'existing' && (
            <span className="ml-2 inline-block">
              <Badge tone="amber">Allowed (existing linked phone)</Badge>
            </span>
          )}
          <span className="block text-xs text-stone-500">{LINKED_DEVICE_NOTES[state]}</span>
        </span>
      </label>
      {state === 'unknown' && (
        <button
          type="button"
          className="btn btn-quiet self-center"
          disabled={pending}
          onClick={() => onAsk(false)}
        >
          Stop pairing
        </button>
      )}
    </div>
  );
}

/** Deletes one whole business, once the admin types its name (DeleteBusinessDialog). */
export function DeleteBusinessButton({
  name,
  canDelete,
  onAsk,
}: {
  name: string;
  /** The admin's session is authenticator-verified. */
  canDelete: boolean;
  onAsk: () => void;
}) {
  const blocked = deleteBusinessBlocked(canDelete);
  return (
    <button
      type="button"
      // Red at rest too, as Delete account: touch screens never show the hover.
      className="btn btn-quiet text-red-700 hover:bg-red-50 hover:text-red-700"
      aria-label={`Delete business ${name}`}
      disabled={!!blocked}
      title={blocked}
      onClick={onAsk}
    >
      Delete business
    </button>
  );
}

/**
 * Asks for the business's name, typed exactly, before deleting it for good. When it can't be
 * deleted from here yet (wait), says why and what to do instead of asking for the name.
 */
export function DeleteBusinessDialog({
  open,
  onOpenChange,
  name,
  wait,
  typed,
  onTyped,
  busy,
  error,
  onConfirm,
  returnFocusTo,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  /** Why it can't be deleted yet (deleteBusinessWait), or undefined. */
  wait?: string;
  typed: string;
  onTyped: (value: string) => void;
  busy: boolean;
  error: string;
  onConfirm: () => void;
  /** Where focus goes once it closes after the business went (its card goes too). */
  returnFocusTo?: () => HTMLElement | null | undefined;
}) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      {...deleteBusinessCopy(name)}
      busy={busy}
      error={error}
      confirmDisabled={!!wait || !businessNameMatches(typed, name)}
      confirmTitle={wait ?? `Type ${name} first.`}
      onConfirm={onConfirm}
      returnFocusTo={returnFocusTo}
    >
      {wait ? (
        <p className={note}>{wait}</p>
      ) : (
        <Field label={`Type ${name} to confirm`}>
          <input
            className="input"
            value={typed}
            // Kept as it was while the deletion runs, without greying out the dialog.
            readOnly={busy}
            autoComplete="off"
            // A phone keyboard must not change the name as it is typed.
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            onChange={(e) => onTyped(e.target.value)}
          />
        </Field>
      )}
    </ConfirmDialog>
  );
}

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
  // Allowing or stopping linked-phone pairing for one business, waiting for confirmation. Kept
  // while the dialog closes, so its text doesn't vanish mid-animation.
  const [linked, setLinked] = useState<{ companyId: string; name: string; allowed: boolean }>();
  const [linkedOpen, setLinkedOpen] = useState(false);
  const [linkedError, setLinkedError] = useState('');
  // The business being deleted (with why it can't be yet, if so), and the name typed to confirm
  // it. Kept while the dialog closes, so its text doesn't vanish mid-animation.
  const [deleting, setDeleting] = useState<{ id: string; name: string; wait?: string }>();
  const [deletingOpen, setDeletingOpen] = useState(false);
  const [typedName, setTypedName] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const emailInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  // Where focus goes once a business is deleted: its card, and the button that opened the
  // dialog, go with the reload.
  const focusAfterDelete = useRef<HTMLElement | null>(null);
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
  // A business with no saved choice may still pair while its linked phone from before approvals
  // is in use: ask the server for each one, so the switch shows what is really possible.
  const [effective, setEffective] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (data.role !== 'admin' || !directory) return;
    let active = true;
    for (const business of directory.businesses)
      if (data.companies.find((c) => c.id === business.id)?.linkedDeviceAllowed === undefined)
        api<{ pairingAllowed?: boolean }>('/whatsapp/connection', business.id)
          .then(({ pairingAllowed }) => {
            if (active && typeof pairingAllowed === 'boolean')
              setEffective((current) => ({ ...current, [business.id]: pairingAllowed }));
          })
          .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [directory]);

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
    // One change at a time: a running one must finish against the person it was asked for.
    if (pending === 'change') return;
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
        // Red at rest too: touch screens never show the hover, and this can't be undone.
        className="btn btn-quiet text-red-700 hover:bg-red-50 hover:text-red-700"
        aria-label={`Delete account for ${personName(person)}`}
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
  // Whether this business may pair a linked phone. The saved setting comes with the workspace,
  // where the admin sees every business; the box changes only once the admin confirms.
  const linkedToggle = (business: PeopleDirectory['businesses'][number]) => {
    const state = linkedDeviceState(
      data.companies.find((c) => c.id === business.id)?.linkedDeviceAllowed,
      effective[business.id],
    );
    const askLinked = (allowed: boolean) => {
      setLinkedError('');
      setLinked({ companyId: business.id, name: business.name, allowed });
      setLinkedOpen(true);
    };
    return <LinkedDeviceSwitch state={state} pending={pending === 'linked'} onAsk={askLinked} />;
  };
  const details = (person: PeopleAccount, memberRole?: 'owner' | 'staff') => (
    <div className="min-w-0">
      <p className="text-sm font-semibold text-ink break-all">{personName(person)}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {memberRole && (
          <Badge tone={memberRole === 'owner' ? 'amber' : 'neutral'}>{label(memberRole)}</Badge>
        )}
        {person.you && <Badge tone="green">You</Badge>}
        {!directory?.emailsUnavailable && lastSeen(person) && (
          <span className="text-xs text-stone-500">{lastSeen(person)}</span>
        )}
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
            To delete accounts and businesses, turn on authenticator protection in Security &
            privacy first.
          </p>
        )}
      </div>
      <section className="card mb-6 p-5 sm:p-6 space-y-4">
        <h2 className="panel-title">Add someone to a business</h2>
        <form
          className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
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
              ref={emailInput}
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
        ref={searchInput}
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
              <section key={business.id} data-business={business.id} className="card p-5 sm:p-6">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="panel-title break-words">{business.name}</h2>
                    <p className="mt-1 text-sm text-stone-500">
                      {total} {total === 1 ? 'person' : 'people'}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      className="btn btn-quiet"
                      aria-label={`Open ${business.name}`}
                      onClick={() => {
                        go(workspacePath(business.slug, 'security'));
                        window.scrollTo(0, 0);
                      }}
                    >
                      Open
                    </button>
                    <DeleteBusinessButton
                      name={business.name}
                      canDelete={!!directory?.canDeleteAccounts}
                      onAsk={() => {
                        // One change at a time, as for people.
                        if (pending === 'deleteBusiness') return;
                        setDeleteError('');
                        setTypedName('');
                        focusAfterDelete.current = null;
                        setDeleting({
                          id: business.id,
                          name: business.name,
                          // The server checks both again.
                          wait: deleteBusinessWait(
                            business.id === data.company.id,
                            data.companies.find((c) => c.id === business.id)?.botEnabled === true,
                          ),
                        });
                        setDeletingOpen(true);
                      }}
                    />
                  </div>
                </div>
                {linkedToggle(business)}
                {!members.length && (
                  <p className="mt-4 rounded-2xl border border-dashed border-ink/10 bg-paper/70 px-4 py-6 text-center text-sm text-stone-500">
                    Nobody has been added yet.
                  </p>
                )}
                <ul className="mt-3 divide-y divide-ink/[0.05]">
                  {members.map(({ person, role: memberRole }) => (
                    <li
                      key={person.userId}
                      className="flex flex-wrap items-center justify-between gap-3 py-3"
                    >
                      {details(person, memberRole)}
                      <div className="flex flex-wrap items-center gap-2">
                        {/* A fixed width keeps the buttons beside the select. */}
                        <div className="w-36 shrink-0">
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
                        </div>
                        {!person.you && (
                          <button
                            type="button"
                            className="btn btn-quiet hover:bg-red-50 hover:text-red-700"
                            aria-label={`Remove ${personName(person)} from ${business.name}`}
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
                            // Focus also scrolls the field into view.
                            emailInput.current?.focus();
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
        onOpenChange={(open) => {
          // Stays open until a running change finishes, so its result lands on this person.
          if (!open && pending === 'change') return;
          setConfirming(open);
        }}
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
      <ConfirmDialog
        open={linkedOpen}
        onOpenChange={(open) => {
          if (!open && pending === 'linked') return;
          setLinkedOpen(open);
        }}
        {...(linked
          ? linkedDeviceCopy(linked.name, linked.allowed)
          : { title: '', description: '' })}
        busy={pending === 'linked'}
        error={linkedError}
        onConfirm={() => {
          if (!linked) return;
          const request = linkedDeviceRequest(linked.companyId, linked.allowed);
          setLinkedError('');
          void run('linked', async () => {
            try {
              // The workspace reload brings the saved setting back.
              await mutate(request.path, request.body, request.method, {
                dialog: true,
                success: request.success,
              });
              setLinkedOpen(false);
            } catch (e) {
              setLinkedError((e as Error).message);
            }
          });
        }}
      />
      <DeleteBusinessDialog
        open={deletingOpen}
        onOpenChange={(open) => {
          // Stays open until the deletion finishes, so its result lands in the dialog.
          if (!open && pending === 'deleteBusiness') return;
          setDeletingOpen(open);
        }}
        name={deleting?.name ?? ''}
        wait={deleting?.wait}
        typed={typedName}
        onTyped={setTypedName}
        busy={pending === 'deleteBusiness'}
        error={deleteError}
        returnFocusTo={() => focusAfterDelete.current}
        onConfirm={() => {
          if (!deleting || deleting.wait || !businessNameMatches(typedName, deleting.name)) return;
          const request = deleteBusinessRequest(deleting.id, typedName);
          setDeleteError('');
          void run('deleteBusiness', async () => {
            try {
              // The workspace reload takes it out of the business list too.
              const result = await mutate<DeleteBusinessResult>(
                request.path,
                request.body,
                request.method,
                { dialog: true },
              );
              // The next business's Open button (a button, so a phone opens no keyboard), which
              // stays through the reload; the search box when a search hides every other card.
              const card = document.querySelector(`[data-business="${CSS.escape(deleting.id)}"]`);
              focusAfterDelete.current =
                (
                  card?.nextElementSibling ?? card?.previousElementSibling
                )?.querySelector<HTMLElement>('button') ?? searchInput.current;
              setDeletingOpen(false);
              if (companyId === deleting.id) setCompanyId(data.company.id);
              notify(businessDeletedMessage(deleting.name, result));
            } catch (e) {
              setDeleteError((e as Error).message);
            } finally {
              setLoads((n) => n + 1);
            }
          });
        }}
      />
    </>
  );
}
