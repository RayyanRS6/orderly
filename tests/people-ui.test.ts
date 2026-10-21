import { describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Radix draws dialogs into a portal, which server rendering skips: draw them in place.
vi.mock('@radix-ui/react-alert-dialog', async () => {
  const { createElement } = await import('react');
  type Props = { children?: ReactNode; className?: string };
  const tag =
    (name: string) =>
    ({ children, className }: Props) =>
      createElement(name, { className }, children);
  return {
    Root: ({ open, children }: Props & { open?: boolean }) => (open ? children : null),
    Portal: ({ children }: Props) => children,
    Overlay: tag('div'),
    Content: tag('div'),
    Title: tag('h2'),
    Description: tag('p'),
    Cancel: tag('button'),
  };
});
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
  describeTeamChange,
  groupPeople,
  lastSeen,
  personName,
  soleOwnerOf,
} from '../src/lib/people';
import { DeleteBusinessButton, DeleteBusinessDialog, People } from '../src/components/People';
import { SecuritySettings } from '../src/components/Operations';
import { ConfirmDialog } from '../src/components/ui';
import { Workspace, type WorkspaceContext } from '../src/lib/workspace';
import { seedCompanies } from '../src/shared/seed';
import type { Bootstrap, PeopleAccount, PeopleDirectory } from '../src/shared/types';

const id = (n: number) => `${String(n).repeat(8)}-0000-4000-8000-000000000000`;
const sara: PeopleAccount = {
  userId: id(1),
  email: 'sara@x.com',
  lastSignInAt: '2026-10-15T09:00:00.000Z',
  admin: false,
  memberships: [
    { companyId: 'a', role: 'owner' },
    { companyId: 'b', role: 'staff' },
  ],
};
const ali: PeopleAccount = {
  userId: id(2),
  email: 'ali@x.com',
  admin: false,
  memberships: [{ companyId: 'a', role: 'staff' }],
};
const bilal: PeopleAccount = {
  userId: id(3),
  email: 'bilal@x.com',
  admin: false,
  memberships: [{ companyId: 'b', role: 'owner' }],
};
const zara: PeopleAccount = {
  userId: id(4),
  email: 'zara@x.com',
  admin: false,
  memberships: [{ companyId: 'b', role: 'owner' }],
};
const lonely: PeopleAccount = {
  userId: id(5),
  email: 'lonely@x.com',
  admin: false,
  memberships: [],
};
const founder: PeopleAccount = {
  userId: id(6),
  email: 'founder@x.com',
  admin: true,
  you: true,
  memberships: [],
};
const directory: PeopleDirectory = {
  businesses: [
    { id: 'a', name: 'Dastarkhwan', slug: 'dastarkhwan' },
    { id: 'b', name: 'Bun & Co.', slug: 'bun-and-co' },
  ],
  accounts: [ali, bilal, founder, lonely, sara, zara],
  canDeleteAccounts: true,
};

describe('people helpers', () => {
  it('groups people by business with owners first, and searches', () => {
    const all = groupPeople(directory, '');
    expect(all.businesses.map((b) => b.business.name)).toEqual(['Dastarkhwan', 'Bun & Co.']);
    expect(all.businesses[0].members.map((m) => [m.person.email, m.role])).toEqual([
      ['sara@x.com', 'owner'],
      ['ali@x.com', 'staff'],
    ]);
    expect(all.businesses[1].members.map((m) => m.person.email)).toEqual([
      'bilal@x.com',
      'zara@x.com',
      'sara@x.com',
    ]);
    expect(all.unassigned).toEqual([lonely]);
    expect(all.admins).toEqual([founder]);
    const byEmail = groupPeople(directory, 'ALI@');
    expect(byEmail.businesses).toEqual([
      { business: directory.businesses[0], members: [{ person: ali, role: 'staff' }], total: 2 },
    ]);
    expect(byEmail.unassigned).toEqual([]);
    const byBusiness = groupPeople(directory, 'bun');
    expect(byBusiness.businesses.map((b) => b.business.id)).toEqual(['b']);
    expect(byBusiness.businesses[0].members).toHaveLength(3);
    expect(groupPeople(directory, id(5).slice(0, 8)).unassigned).toEqual([lonely]);
  });

  it('names only businesses where the person is the single owner', () => {
    expect(soleOwnerOf(directory, sara)).toEqual(['Dastarkhwan']);
    expect(soleOwnerOf(directory, bilal)).toEqual([]);
    expect(soleOwnerOf(directory, ali)).toEqual([]);
  });

  it('describes each change for the confirm dialog', () => {
    expect(
      describeChange({ kind: 'role', person: ali, companyId: 'a', role: 'owner' }, directory),
    ).toMatchObject({
      title: 'Make ali@x.com an owner of Dastarkhwan?',
      confirmLabel: 'Make owner',
      tone: 'primary',
    });
    expect(
      describeChange({ kind: 'role', person: sara, companyId: 'b', role: 'staff' }, directory),
    ).toMatchObject({ title: 'Make sara@x.com staff at Bun & Co.?', tone: 'primary' });
    expect(
      describeChange({ kind: 'remove', person: ali, companyId: 'a' }, directory),
    ).toMatchObject({ title: 'Remove ali@x.com from Dastarkhwan?', tone: 'danger' });
    const sole = describeChange({ kind: 'delete', person: sara }, directory);
    expect(sole.title).toBe('Delete sara@x.com’s account?');
    expect(sole.description).toContain('removes them from: Dastarkhwan, Bun & Co.');
    expect(sole.description).toContain('Dastarkhwan will have no owner left.');
    expect(sole.description).toMatch(/Past activity stays in the records\.$/);
    expect(sole.tone).toBe('danger');
    const shared = describeChange({ kind: 'delete', person: bilal }, directory);
    expect(shared.description).not.toContain('no owner left');
    expect(describeChange({ kind: 'delete', person: lonely }, directory).description).toBe(
      'This deletes their sign-in for good. Past activity stays in the records.',
    );
    const unread = { ...lonely, email: undefined, userId: '1a2b3c4d-0000-4000-8000-000000000000' };
    expect(describeChange({ kind: 'delete', person: unread }, directory).title).toBe(
      'Delete this account (1a2b3c4d)?',
    );
  });

  it('builds the request for each confirmed change', () => {
    expect(changeRequest({ kind: 'role', person: ali, companyId: 'a', role: 'owner' })).toEqual({
      path: `/admin/businesses/a/members/${ali.userId}`,
      method: 'PUT',
      body: { role: 'owner' },
      success: 'Role updated.',
    });
    expect(changeRequest({ kind: 'remove', person: ali, companyId: 'a' })).toMatchObject({
      method: 'DELETE',
      body: undefined,
    });
    expect(changeRequest({ kind: 'delete', person: ali })).toMatchObject({
      path: `/admin/accounts/${ali.userId}`,
      method: 'DELETE',
    });
  });

  it('uses the same words for owners’ team changes', () => {
    const member = { userId: ali.userId, email: ali.email, role: 'staff' as const };
    expect(describeTeamChange({ kind: 'role', member, role: 'owner' }, 'Dastarkhwan')).toEqual(
      describeChange({ kind: 'role', person: ali, companyId: 'a', role: 'owner' }, directory),
    );
    expect(describeTeamChange({ kind: 'remove', member }, 'Dastarkhwan').confirmLabel).toBe(
      'Remove access',
    );
  });

  it('names people and their last sign-in', () => {
    expect(personName({ userId: '1a2b3c4d-0000-4000-8000-000000000000' })).toBe('Account 1a2b3c4d');
    expect(personName(ali)).toBe('ali@x.com');
    expect(lastSeen({ userId: id(1), invited: true })).toBe('Invited, hasn’t signed in yet');
    expect(lastSeen({ userId: id(1), createdAt: '2026-10-01T09:00:00.000Z' })).toBe(
      'Hasn’t signed in yet',
    );
    // An account that couldn't be read says nothing, rather than looking unused.
    expect(lastSeen({ userId: id(1) })).toBe('');
    expect(lastSeen(sara)).toMatch(/^Last signed in /);
  });

  it('says what happened after adding someone', () => {
    expect(addedMessage('a@x.com', 'added')).toBe('a@x.com was added. They can sign in now.');
    expect(addedMessage('a@x.com', 'added_waiting')).toContain('haven’t signed in to Orderly yet');
    expect(addedMessage('a@x.com', 'invited')).toBe('Invitation sent to a@x.com.');
    expect(addedMessage('a@x.com')).toBe('Invitation sent to a@x.com.');
  });
});

function render(role: Bootstrap['role'], component: () => unknown) {
  const data: Bootstrap = {
    mode: 'live',
    role,
    company: seedCompanies[0],
    companies: seedCompanies,
    products: [],
    orders: [],
    conversations: [],
    integrations: [],
    aiConnection: { provider: 'mock', configured: true },
    usage: [],
    traces: [],
  };
  const context: WorkspaceContext = {
    data,
    busy: false,
    error: '',
    clearError: () => {},
    page: 'people',
    navigate: () => {},
    switchCompany: () => {},
    refresh: async () => {},
    notify: () => {},
    mutate: async <T>() => ({}) as T,
  };
  return renderToStaticMarkup(
    createElement(Workspace.Provider, { value: context }, createElement(component as () => null)),
  );
}

describe('people screens', () => {
  it('shows the admin the People page while it loads', () => {
    const html = render('admin', People);
    expect(html).toContain('People');
    expect(html).toContain('Loading people…');
    expect(html).toContain('Add someone to a business');
  });

  it('tells everyone else the page is only for the admin', () => {
    const html = render('owner', People);
    expect(html).toContain('This page is only for the Orderly admin.');
    expect(html).not.toContain('Add someone');
  });

  it('lets owners add teammates by email, not by account ID', () => {
    const html = render('owner', SecuritySettings);
    expect(html).toContain('Add to team');
    expect(html).toContain('Their email');
    expect(html).not.toContain('Existing Supabase user ID');
  });

  it('says on the page that the authenticator is needed to delete accounts and businesses', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/People.tsx'), 'utf8');
    expect(source.replace(/\s+/g, ' ')).toContain(
      'To delete accounts and businesses, turn on authenticator protection in Security & privacy first.',
    );
  });

  it('draws a non-destructive confirmation in the main colour', () => {
    const props = {
      open: true,
      onOpenChange: () => {},
      title: 'Make owner?',
      description: 'Owners can change the menu.',
      onConfirm: () => {},
      confirmLabel: 'Make owner',
    };
    const primary = renderToStaticMarkup(
      createElement(ConfirmDialog, { ...props, tone: 'primary' }),
    );
    expect(primary).toContain('Make owner');
    expect(primary).toContain('btn-primary');
    expect(primary).not.toContain('bg-red-700');
    const danger = renderToStaticMarkup(createElement(ConfirmDialog, props));
    expect(danger).toContain('bg-red-700');
    expect(danger).not.toContain('btn-primary');
  });
});

describe('deleting a business', () => {
  // The confirm button, with its attributes.
  const confirmButton = (html: string) =>
    html.match(/<button[^>]*>(?:(?!<\/button>).)*Delete business<\/button>/)?.[0] ?? '';
  const dialog = (typed: string, extra: { busy?: boolean; error?: string; wait?: string } = {}) =>
    renderToStaticMarkup(
      createElement(DeleteBusinessDialog, {
        open: true,
        onOpenChange: () => {},
        name: 'Laziza',
        typed,
        onTyped: () => {},
        busy: false,
        error: '',
        onConfirm: () => {},
        ...extra,
      }),
    );

  it('says what goes, in plain words, and that people stay', () => {
    expect(deleteBusinessCopy('Laziza')).toEqual({
      title: 'Delete Laziza?',
      description:
        'This permanently deletes its menu, deals, chats, orders, settings and WhatsApp connection. It can’t be undone. Its people stay: they just lose access to this business.',
      confirmLabel: 'Delete business',
      busyLabel: 'Deleting…',
      tone: 'danger',
    });
    expect(deleteBusinessRequest('a b', '  Laziza ')).toEqual({
      path: '/admin/businesses/a%20b',
      method: 'DELETE',
      body: { name: 'Laziza' },
    });
    expect(businessDeletedMessage('Laziza', { peopleLeftWithoutBusiness: 0 })).toBe(
      'Laziza was deleted.',
    );
    expect(businessDeletedMessage('Laziza', { peopleLeftWithoutBusiness: 1 })).toBe(
      'Laziza was deleted. 1 person is in no business now. You can find them under “Not in any business yet”.',
    );
    expect(businessDeletedMessage('Laziza', { peopleLeftWithoutBusiness: 2 })).toContain(
      '2 people are in no business now.',
    );
  });

  it('needs the name typed exactly, spaces around it aside', () => {
    expect(businessNameMatches('Laziza', 'Laziza')).toBe(true);
    expect(businessNameMatches('  Laziza ', 'Laziza')).toBe(true);
    for (const typed of ['', '   ', 'laziza', 'Laziz', 'Laziza Restaurant'])
      expect(businessNameMatches(typed, 'Laziza'), typed).toBe(false);
    // As the page shows it and a phone types it: one space for many, either apostrophe, and the
    // same letters in either Unicode form.
    expect(businessNameMatches('Fries & Buns', 'Fries  & Buns')).toBe(true);
    expect(businessNameMatches('Nando’s', "Nando's")).toBe(true);
    expect(businessNameMatches("Nando's", 'Nando’s')).toBe(true);
    expect(businessNameMatches('Café', 'Café')).toBe(true);
    expect(businessNameMatches('Fries', 'Fries & Buns')).toBe(false);
    expect(businessNameMatches('', '')).toBe(false);
    // The confirm button stays off until then, and says why.
    for (const typed of ['', 'laziza', 'Laziz']) {
      const button = confirmButton(dialog(typed));
      expect(button, typed).toContain('disabled=""');
      expect(button, typed).toContain('title="Type Laziza first."');
    }
    const ready = dialog(' Laziza ');
    expect(confirmButton(ready)).not.toContain('disabled');
    expect(confirmButton(ready)).toContain('bg-red-700');
    expect(ready).toContain('Delete Laziza?');
    expect(ready).toContain('Type Laziza to confirm');
    expect(ready).toContain('value=" Laziza "');
    // A phone keyboard leaves the name as typed.
    expect(ready).toMatch(/<input[^>]*autoCorrect="off"[^>]*autoCapitalize="none"/);
    // While it runs: the box is locked and the button says so; a failure shows inside.
    const busy = dialog('Laziza', { busy: true, error: 'Something went wrong.' });
    expect(busy).toContain('Deleting…');
    expect(busy).toMatch(/<input[^>]*readOnly=""/);
    expect(busy).toContain('Something went wrong.');
  });

  it('is off only without the authenticator, which the page note explains', () => {
    const button = (canDelete: boolean) =>
      renderToStaticMarkup(
        createElement(DeleteBusinessButton, { name: 'Laziza', canDelete, onAsk: () => {} }),
      );
    expect(deleteBusinessBlocked(true)).toBeUndefined();
    const ready = button(true);
    // Its accessible name holds what it shows, for voice control.
    expect(ready).toContain('aria-label="Delete business Laziza"');
    expect(ready).toContain('Delete business');
    expect(ready).toContain('text-red-700');
    expect(ready).not.toContain('disabled');
    expect(button(false)).toContain(
      'title="Turn on authenticator protection in Security &amp; privacy first."',
    );
    expect(button(false)).toContain('disabled=""');
  });

  it('says in the dialog, not a tooltip, what to do for the open business or a bot still on', () => {
    expect(deleteBusinessWait(false, false)).toBeUndefined();
    expect(deleteBusinessWait(true, false)).toBe(
      'This business is open now. Press Open on another business, then come back to People to delete this one.',
    );
    expect(deleteBusinessWait(false, true)).toBe(
      'Its bot is still on. Open it, pause the bot (Bot settings → Pause automation), then open another business and come back to People to delete it.',
    );
    expect(deleteBusinessWait(true, true)).toBe(
      'This business is open now and its bot is on. Pause its bot first (Bot settings → Pause automation), then press Open on another business and come back to People to delete it.',
    );
    const wait = deleteBusinessWait(true, false)!;
    // Even with the name typed, it can't be confirmed, and the name box is not asked for.
    const html = dialog('Laziza', { wait });
    expect(html).toContain(wait);
    expect(html).not.toContain('Type Laziza to confirm');
    expect(html).not.toContain('<input');
    expect(confirmButton(html)).toContain('disabled=""');
    expect(confirmButton(html)).toContain(`title="${wait}"`);
  });
});
