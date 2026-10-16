import type {
  Account,
  AddMemberOutcome,
  PeopleAccount,
  PeopleDirectory,
  TeamMember,
} from '../shared/types';
import { shortDate } from './utils';

// Pure helpers for the admin's People page and owners' Team access. Kept apart from
// People.tsx so Team access can use them without loading that page.

type Role = 'owner' | 'staff';
type Business = PeopleDirectory['businesses'][number];

export interface ChangeCopy {
  title: string;
  description: string;
  confirmLabel: string;
  busyLabel: string;
  tone: 'danger' | 'primary';
}
/** A change on the People page, waiting for the admin to confirm it. */
export type PeopleChange =
  | { kind: 'role'; person: PeopleAccount; companyId: string; role: Role }
  | { kind: 'remove'; person: PeopleAccount; companyId: string }
  | { kind: 'delete'; person: PeopleAccount };
/** A change in an owner's Team access, waiting for them to confirm it. */
export type TeamChange =
  { kind: 'role'; member: TeamMember; role: Role } | { kind: 'remove'; member: TeamMember };

export const personName = (p: { email?: string; userId: string }) =>
  p.email || `Account ${p.userId.slice(0, 8)}`;

export function lastSeen(p: Account) {
  if (p.lastSignInAt) return `Last signed in ${shortDate(p.lastSignInAt)}`;
  return p.invited ? 'Invited, hasn’t signed in yet' : 'Hasn’t signed in yet';
}

const byEmail = (a: { email?: string; userId: string }, b: { email?: string; userId: string }) =>
  (a.email ?? '').localeCompare(b.email ?? '') || a.userId.localeCompare(b.userId);
const businessName = (businesses: Business[], id: string) =>
  businesses.find((b) => b.id === id)?.name ?? 'this business';

/**
 * People grouped by business, owners first. A search matches an email, an account ID or a
 * business name (which shows everyone in it).
 */
export function groupPeople(d: PeopleDirectory, search: string) {
  const query = search.trim().toLowerCase();
  const matches = (p: PeopleAccount) =>
    !query || !!p.email?.toLowerCase().includes(query) || p.userId.toLowerCase().includes(query);
  const businesses = d.businesses
    .map((business) => {
      const all = !query || business.name.toLowerCase().includes(query);
      const everyone = d.accounts
        .flatMap((person) => {
          const membership = person.memberships.find((m) => m.companyId === business.id);
          return membership ? [{ person, role: membership.role }] : [];
        })
        .sort(
          (a, b) =>
            Number(b.role === 'owner') - Number(a.role === 'owner') || byEmail(a.person, b.person),
        );
      const members = all ? everyone : everyone.filter((m) => matches(m.person));
      return { business, members, total: everyone.length, all };
    })
    .filter((b) => b.all || b.members.length)
    .map(({ business, members, total }) => ({ business, members, total }));
  return {
    businesses,
    unassigned: d.accounts.filter((p) => !p.memberships.length && !p.admin && matches(p)),
    admins: d.accounts.filter((p) => p.admin && matches(p)),
  };
}

/** Businesses where this person is the only owner. */
export function soleOwnerOf(d: PeopleDirectory, person: PeopleAccount) {
  return person.memberships
    .filter(
      (m) =>
        m.role === 'owner' &&
        !d.accounts.some(
          (other) =>
            other.userId !== person.userId &&
            other.memberships.some((o) => o.companyId === m.companyId && o.role === 'owner'),
        ),
    )
    .map((m) => businessName(d.businesses, m.companyId));
}

const list = (names: string[]) =>
  names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

function roleCopy(name: string, business: string, role: Role): ChangeCopy {
  return role === 'owner'
    ? {
        title: `Make ${name} an owner of ${business}?`,
        description: 'Owners can change the menu, connections and team for this business.',
        confirmLabel: 'Make owner',
        busyLabel: 'Saving…',
        tone: 'primary',
      }
    : {
        title: `Make ${name} staff at ${business}?`,
        description: 'They keep orders and chats, but can’t change settings or the team.',
        confirmLabel: 'Make staff',
        busyLabel: 'Saving…',
        tone: 'primary',
      };
}
function removeCopy(name: string, business: string): ChangeCopy {
  return {
    title: `Remove ${name} from ${business}?`,
    description:
      'They lose access to this business right away. Their account and other businesses stay as they are.',
    confirmLabel: 'Remove access',
    busyLabel: 'Removing…',
    tone: 'danger',
  };
}

export function describeChange(change: PeopleChange, d: PeopleDirectory): ChangeCopy {
  const name = personName(change.person);
  if (change.kind === 'role')
    return roleCopy(name, businessName(d.businesses, change.companyId), change.role);
  if (change.kind === 'remove')
    return removeCopy(name, businessName(d.businesses, change.companyId));
  const businesses = change.person.memberships.map((m) => businessName(d.businesses, m.companyId));
  const orphaned = soleOwnerOf(d, change.person);
  return {
    title: `Delete ${name}’s account?`,
    description: [
      businesses.length
        ? `This deletes their sign-in for good and removes them from: ${businesses.join(', ')}.`
        : 'This deletes their sign-in for good.',
      orphaned.length &&
        `${list(orphaned)} will have no owner left. You can still open ${
          orphaned.length > 1 ? 'them' : 'it'
        } and add a new owner.`,
      'Past activity stays in the records.',
    ]
      .filter(Boolean)
      .join(' '),
    confirmLabel: 'Delete account',
    busyLabel: 'Deleting…',
    tone: 'danger',
  };
}

/** The request that carries out a confirmed People change. */
export function changeRequest(change: PeopleChange) {
  const user = encodeURIComponent(change.person.userId);
  if (change.kind === 'delete')
    return {
      path: `/admin/accounts/${user}`,
      method: 'DELETE',
      body: undefined,
      success: 'Account deleted.',
    };
  const path = `/admin/businesses/${encodeURIComponent(change.companyId)}/members/${user}`;
  return change.kind === 'role'
    ? { path, method: 'PUT', body: { role: change.role }, success: 'Role updated.' }
    : { path, method: 'DELETE', body: undefined, success: 'Access removed.' };
}

export function describeTeamChange(change: TeamChange, business: string): ChangeCopy {
  const name = personName(change.member);
  return change.kind === 'role'
    ? roleCopy(name, business, change.role)
    : removeCopy(name, business);
}

export function addedMessage(email: string, outcome?: AddMemberOutcome) {
  if (outcome === 'added') return `${email} was added. They can sign in now.`;
  if (outcome === 'added_waiting')
    return `${email} was added. They haven’t signed in to Orderly yet, so remind them to open their invitation email.`;
  // Servers older than add-by-email answer without an outcome: they always invited.
  return `Invitation sent to ${email}.`;
}
