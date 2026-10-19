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

/** shortDate, plus the year when it isn't this year, so an old sign-in doesn't look recent. */
function signInDate(value: string) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime()) || d.getFullYear() === new Date().getFullYear())
    return shortDate(value);
  try {
    return d.toLocaleString('en-PK', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return d.toISOString().slice(0, 16).replace('T', ' ');
  }
}

/** Empty when the account itself couldn't be read, so nobody looks inactive by mistake. */
export function lastSeen(p: Account) {
  if (p.lastSignInAt) return `Last signed in ${signInDate(p.lastSignInAt)}`;
  if (p.invited) return 'Invited, hasn’t signed in yet';
  return p.createdAt ? 'Hasn’t signed in yet' : '';
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
  const businesses = change.person.memberships
    .map((m) => businessName(d.businesses, m.companyId))
    .join(', ');
  // A name such as 'Bun & Co.' already ends the sentence.
  const stop = businesses.endsWith('.') ? '' : '.';
  const orphaned = soleOwnerOf(d, change.person);
  return {
    title: change.person.email
      ? `Delete ${name}’s account?`
      : `Delete this account (${change.person.userId.slice(0, 8)})?`,
    description: [
      businesses
        ? `This deletes their sign-in for good and removes them from: ${businesses}${stop}`
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

/** The admin allowing, or stopping, new linked-phone pairings for one business. */
export function linkedDeviceCopy(business: string, allowed: boolean): ChangeCopy {
  return allowed
    ? {
        title: `Allow linked-phone pairing for ${business}?`,
        description:
          'Its owners can then link the restaurant’s WhatsApp phone to Orderly. This unofficial method is against WhatsApp’s terms: WhatsApp can ban the whole number, temporarily or permanently, including the restaurant’s own WhatsApp app. Allow it only for a restaurant that has accepted that risk. The official WhatsApp Business Platform needs no approval.',
        confirmLabel: 'Allow pairing',
        busyLabel: 'Saving…',
        tone: 'danger',
      }
    : {
        title: `Stop linked-phone pairing for ${business}?`,
        description:
          'Its owners can no longer switch to a linked phone. A business already using one keeps it, and can still reconnect or disconnect it.',
        confirmLabel: 'Stop pairing',
        busyLabel: 'Saving…',
        tone: 'primary',
      };
}
/**
 * Whether a business can start a new linked-phone pairing, as the server decides it
 * (pairingAllowed in server/whatsapp/routes.ts): the admin's saved choice, or, where none was
 * ever saved, whether its linked phone from before approvals is still in use. `pairingAllowed` is
 * the server's answer for a business without a saved choice; undefined when it couldn't be read.
 */
export type LinkedDeviceState = 'allowed' | 'existing' | 'stopped' | 'not_allowed' | 'unknown';
export function linkedDeviceState(
  saved: boolean | undefined,
  pairingAllowed?: boolean,
): LinkedDeviceState {
  if (saved === true) return 'allowed';
  if (saved === false) return 'stopped';
  if (pairingAllowed === undefined) return 'unknown';
  return pairingAllowed ? 'existing' : 'not_allowed';
}
/** Ticked whenever new pairings are possible, so unticking stops them in one step. */
export const linkedDeviceOn = (state: LinkedDeviceState) =>
  state === 'allowed' || state === 'existing';
const LINKED_RISK = 'The unofficial WhatsApp route. WhatsApp can ban a number linked this way.';
export const LINKED_DEVICE_NOTES: Record<LinkedDeviceState, string> = {
  allowed: LINKED_RISK,
  existing:
    'It used a linked phone before approvals existed, so its owners can still start a new pairing, even for another number, until you stop it. Untick to stop; the phone linked now keeps working.',
  stopped: LINKED_RISK,
  not_allowed: LINKED_RISK,
  unknown:
    'Not decided yet. A business already using a linked phone can still start a new pairing until you stop it.',
};
/** The request that carries out a confirmed linked-phone change. */
export function linkedDeviceRequest(companyId: string, allowed: boolean) {
  return {
    path: `/admin/businesses/${encodeURIComponent(companyId)}/linked-device`,
    method: 'PUT',
    body: { allowed },
    success: allowed ? 'Linked-phone pairing allowed.' : 'Linked-phone pairing stopped.',
  };
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
