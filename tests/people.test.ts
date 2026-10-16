import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../server/app';
import { MemoryRepository } from '../server/repository';
import { LAST_OWNER_MESSAGE } from '../server/security';
import { seedCompanies } from '../src/shared/seed';
import type { PeopleDirectory, TeamMember } from '../src/shared/types';

const people = vi.hoisted(() => {
  const jwt = (claims: object) =>
    `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
  const ids = {
    ADMIN: '11111111-1111-4111-8111-111111111111',
    OWNER: '22222222-2222-4222-8222-222222222222',
    STAFF: '33333333-3333-4333-8333-333333333333',
    OTHER: '44444444-4444-4444-8444-444444444444',
    LONELY: '55555555-5555-4555-8555-555555555555',
    PENDING: '66666666-6666-4666-8666-666666666666',
    SECOND_ADMIN: '77777777-7777-4777-8777-777777777777',
  };
  const tokens = {
    admin: 'admin-session',
    adminMfa: jwt({ aal: 'aal2' }),
    owner: 'owner-session',
    staff: 'staff-session',
    other: 'other-session',
  };
  const users: Record<string, { id: string; factors?: { status: string }[] }> = {
    [tokens.admin]: { id: ids.ADMIN },
    [tokens.adminMfa]: { id: ids.ADMIN, factors: [{ status: 'verified' }] },
    [tokens.owner]: { id: ids.OWNER },
    [tokens.staff]: { id: ids.STAFF },
    [tokens.other]: { id: ids.OTHER },
  };
  return { ids, tokens, users };
});
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: {
      getUser: async (token: string) =>
        people.users[token]
          ? { data: { user: people.users[token] }, error: null }
          : { data: { user: null }, error: { message: 'invalid' } },
    },
  }),
}));

const { ids, tokens } = people;
const A = seedCompanies[0];
const B = seedCompanies[1];
const signedIn = '2026-10-15T09:00:00.000Z';
let repo: MemoryRepository;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-16T10:00:10.000Z'));
  repo = new MemoryRepository();
  for (const [userId, email, extra] of [
    [ids.ADMIN, 'admin@example.com', { lastSignInAt: signedIn }],
    [ids.OWNER, 'owner@example.com', { lastSignInAt: signedIn }],
    [ids.STAFF, 'staff@example.com', { lastSignInAt: signedIn }],
    [ids.OTHER, 'other@example.com', { lastSignInAt: signedIn }],
    [ids.LONELY, 'lonely@example.com', { lastSignInAt: signedIn }],
    [ids.PENDING, 'pending@example.com', { invited: true }],
  ] as const)
    await repo.addAccount({ userId, email, createdAt: '2026-09-01T00:00:00.000Z', ...extra });
  await repo.grantAdmin(ids.ADMIN);
  await repo.setMember(A.id, { userId: ids.OWNER, role: 'owner' }, ids.ADMIN);
  await repo.setMember(A.id, { userId: ids.STAFF, role: 'staff' }, ids.ADMIN);
  await repo.setMember(B.id, { userId: ids.OTHER, role: 'owner' }, ids.ADMIN);
  vi.stubEnv('APP_MODE', 'live');
  vi.stubEnv('APP_URL', 'http://127.0.0.1:5173');
  vi.stubEnv('ORDERLY_RUNTIME', '');
  vi.stubEnv('VERCEL', '');
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('Unexpected network request'))),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function request(
  token: string,
  path: string,
  options: { method?: string; body?: unknown; company?: string } = {},
) {
  return createApp(repo).request(`http://127.0.0.1/api${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.company ? { 'x-company-id': options.company } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}
const platformAudit = () =>
  (repo as unknown as { state: { platformAudit?: { action: string; actorId: string }[] } }).state
    .platformAudit ?? [];
const actions = async (companyId: string) =>
  (await repo.listTraces(companyId)).map((t) => t.action);
const roleOf = async (companyId: string, userId: string) =>
  (await repo.listMembers(companyId)).find((m) => m.userId === userId)?.role;

describe('admin routes refuse everyone but the platform admin', () => {
  it.each([
    ['owner', tokens.owner],
    ['staff', tokens.staff],
  ])('refuses %s, even in their own business', async (_name, token) => {
    const listAccounts = vi.spyOn(repo, 'listAccounts');
    const deleteAccount = vi.spyOn(repo, 'deleteAccount');
    const setMember = vi.spyOn(repo, 'setMember');
    const calls: [string, string, unknown?][] = [
      ['GET', '/admin/people'],
      ['POST', `/admin/businesses/${A.id}/members`, { email: 'lonely@example.com', role: 'owner' }],
      ['PUT', `/admin/businesses/${A.id}/members/${ids.STAFF}`, { role: 'owner' }],
      ['DELETE', `/admin/businesses/${A.id}/members/${ids.STAFF}`],
      ['DELETE', `/admin/accounts/${ids.STAFF}`],
      ['GET', '/admin/xyz'],
    ];
    for (const [method, path, body] of calls) {
      const res = await request(token, path, { method, body, company: A.id });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(await res.json()).toEqual({ error: 'Only the Orderly admin can manage people.' });
    }
    expect(listAccounts).not.toHaveBeenCalled();
    expect(deleteAccount).not.toHaveBeenCalled();
    expect(setMember).not.toHaveBeenCalled();
    expect(await roleOf(A.id, ids.STAFF)).toBe('staff');
  });

  it('keeps owners inside their own business', async () => {
    const own = await request(tokens.owner, '/bootstrap');
    expect(own.status).toBe(200);
    expect(
      ((await own.json()) as { companies: { id: string }[] }).companies.map((c) => c.id),
    ).toEqual([A.id]);
    expect((await request(tokens.owner, '/bootstrap', { company: B.id })).status).toBe(403);
    expect((await request(tokens.owner, '/team', { company: B.id })).status).toBe(403);
    expect(
      (await request(tokens.owner, `/bootstrap?companySlug=${encodeURIComponent(B.slug)}`)).status,
    ).toBe(403);
  });
});

describe('the admin people directory', () => {
  it('lists every business and account, and records the visit outside any business', async () => {
    const res = await request(tokens.admin, '/admin/people');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const directory = (await res.json()) as PeopleDirectory;
    const businessIds = directory.businesses.map((b) => b.id);
    expect(businessIds).toEqual(expect.arrayContaining([A.id, B.id]));
    for (const business of directory.businesses)
      expect(Object.keys(business).sort()).toEqual(['id', 'name', 'slug']);
    const byEmail = (email: string) => directory.accounts.find((a) => a.email === email);
    expect(byEmail('owner@example.com')?.memberships).toEqual([{ companyId: A.id, role: 'owner' }]);
    expect(byEmail('staff@example.com')?.memberships).toEqual([{ companyId: A.id, role: 'staff' }]);
    expect(byEmail('other@example.com')?.memberships).toEqual([{ companyId: B.id, role: 'owner' }]);
    expect(byEmail('lonely@example.com')?.memberships).toEqual([]);
    expect(byEmail('pending@example.com')).toMatchObject({ invited: true });
    expect(byEmail('admin@example.com')).toMatchObject({ admin: true, you: true });
    expect(byEmail('owner@example.com')).toMatchObject({ admin: false });
    expect(byEmail('owner@example.com')).not.toHaveProperty('you');
    expect(directory.canDeleteAccounts).toBe(false);
    expect(directory.emailsUnavailable).toBeUndefined();
    expect(platformAudit()).toEqual([
      expect.objectContaining({ actorId: ids.ADMIN, action: 'admin.people_viewed' }),
    ]);
    for (const company of [A, B])
      expect((await actions(company.id)).filter((a) => a.includes('admin'))).toEqual([]);
  });

  it('allows deleting accounts only with an authenticator-verified session', async () => {
    const res = await request(tokens.adminMfa, '/admin/people');
    expect(res.status).toBe(200);
    expect(((await res.json()) as PeopleDirectory).canDeleteAccounts).toBe(true);
  });

  it('still lists people by account ID when Supabase Auth cannot be read', async () => {
    vi.spyOn(repo, 'listAccounts').mockRejectedValue(new Error('Auth down'));
    const directory = (await (
      await request(tokens.admin, '/admin/people')
    ).json()) as PeopleDirectory;
    expect(directory.emailsUnavailable).toBe(true);
    expect(directory.accounts.find((a) => a.userId === ids.STAFF)).toMatchObject({
      memberships: [{ companyId: A.id, role: 'staff' }],
    });
    expect(directory.accounts.find((a) => a.userId === ids.STAFF)).not.toHaveProperty('email');
  });
});

describe('owner team list', () => {
  it('shows emails, marks the viewer and people who have not signed in, and nothing account-wide', async () => {
    await repo.setMember(A.id, { userId: ids.PENDING, role: 'staff' }, ids.OWNER);
    const res = await request(tokens.owner, '/team');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const team = (await res.json()) as TeamMember[];
    expect(team.find((m) => m.userId === ids.STAFF)).toMatchObject({
      email: 'staff@example.com',
      waiting: false,
      you: false,
    });
    expect(team.find((m) => m.userId === ids.OWNER)).toMatchObject({
      email: 'owner@example.com',
      you: true,
    });
    expect(team.find((m) => m.userId === ids.PENDING)).toMatchObject({ waiting: true });
    for (const member of team) {
      expect(member).not.toHaveProperty('lastSignInAt');
      expect(member).not.toHaveProperty('createdAt');
    }
  });

  it('still lists the team without emails when accounts cannot be read', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(repo, 'getAccounts').mockRejectedValue(new Error('Auth down'));
    const res = await request(tokens.owner, '/team');
    expect(res.status).toBe(200);
    const team = (await res.json()) as TeamMember[];
    expect(team.map((m) => m.userId).sort()).toEqual([ids.OWNER, ids.STAFF].sort());
    for (const member of team) expect(member).not.toHaveProperty('email');
  });
});

describe('the last-owner rule, with a friendly message', () => {
  it('keeps a business’s only owner until the admin adds another', async () => {
    const remove = await request(tokens.admin, `/admin/businesses/${B.id}/members/${ids.OTHER}`, {
      method: 'DELETE',
    });
    expect(remove.status).toBe(409);
    expect(await remove.json()).toEqual({ error: LAST_OWNER_MESSAGE });
    expect(await roleOf(B.id, ids.OTHER)).toBe('owner');
    const demote = await request(tokens.admin, `/admin/businesses/${B.id}/members/${ids.OTHER}`, {
      method: 'PUT',
      body: { role: 'staff' },
    });
    expect(demote.status).toBe(409);
    expect(await roleOf(B.id, ids.OTHER)).toBe('owner');
    const add = await request(tokens.admin, `/admin/businesses/${B.id}/members`, {
      body: { email: 'owner@example.com', role: 'owner' },
    });
    expect(add.status).toBe(200);
    expect(await add.json()).toEqual({ ok: true, outcome: 'added' });
    expect(
      (
        await request(tokens.admin, `/admin/businesses/${B.id}/members/${ids.OTHER}`, {
          method: 'DELETE',
        })
      ).status,
    ).toBe(200);
    expect(await roleOf(B.id, ids.OTHER)).toBeUndefined();
  });

  it('stops owners removing or demoting themselves', async () => {
    const remove = await request(tokens.owner, `/team/${ids.OWNER}`, { method: 'DELETE' });
    expect(remove.status).toBe(409);
    expect(await remove.json()).toEqual({ error: LAST_OWNER_MESSAGE });
    const demote = await request(tokens.owner, `/team/${ids.OWNER}`, {
      method: 'PUT',
      body: { role: 'staff' },
    });
    expect(demote.status).toBe(409);
    expect(await roleOf(A.id, ids.OWNER)).toBe('owner');
  });
});

describe('owners add people by email', () => {
  const invite = (email: string, role = 'staff') =>
    request(tokens.owner, '/team/invite', { body: { email, role } });

  it('adds existing accounts at once and says whether they have signed in', async () => {
    const lonely = await invite('LONELY@example.com ');
    expect(lonely.status).toBe(200);
    expect(await lonely.json()).toEqual({ ok: true, outcome: 'added' });
    expect(await roleOf(A.id, ids.LONELY)).toBe('staff');
    const pending = await invite('pending@example.com', 'owner');
    expect(await pending.json()).toEqual({ ok: true, outcome: 'added_waiting' });
    expect(await roleOf(A.id, ids.PENDING)).toBe('owner');
    expect(await actions(A.id)).toEqual(
      expect.arrayContaining(['team.member_added', 'POST /api/team/invite']),
    );
  });

  it('never changes an existing member’s role or adds the Orderly admin', async () => {
    expect((await invite('lonely@example.com')).status).toBe(200);
    const again = await invite('lonely@example.com', 'owner');
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toContain('already in this business');
    expect(await roleOf(A.id, ids.LONELY)).toBe('staff');
    const admin = await invite('admin@example.com');
    expect(admin.status).toBe(409);
    expect(((await admin.json()) as { error: string }).error).toContain('Orderly admin');
    expect(await roleOf(A.id, ids.ADMIN)).toBeUndefined();
  });

  it('invites a new email in the hosted workspace', async () => {
    const res = await invite('new.person@example.com');
    expect(await res.json()).toEqual({ ok: true, outcome: 'invited' });
    const account = (await repo.listAccounts()).find((a) => a.email === 'new.person@example.com');
    expect(account).toMatchObject({ invited: true });
    expect(await roleOf(A.id, account!.userId)).toBe('staff');
    expect(await actions(A.id)).toContain('team.invited');
  });

  it('explains that invitations need the hosted workspace in local demo mode', async () => {
    vi.stubEnv('APP_MODE', 'demo');
    const res = await invite('new.person@example.com');
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('hosted workspace');
    expect((await repo.listAccounts()).some((a) => a.email === 'new.person@example.com')).toBe(
      false,
    );
  });

  it('allows five tries a minute', async () => {
    for (let i = 0; i < 5; i++) expect((await invite('staff@example.com')).status).toBe(409);
    expect((await invite('lonely@example.com')).status).toBe(429);
    expect(await roleOf(A.id, ids.LONELY)).toBeUndefined();
  });
});

describe('the admin changes a business that is not open', () => {
  it('records the change in that business only, with no generic route entry', async () => {
    const add = await request(tokens.admin, `/admin/businesses/${B.id}/members`, {
      company: A.id,
      body: { email: 'lonely@example.com', role: 'staff' },
    });
    expect(add.status).toBe(200);
    expect(await add.json()).toEqual({ ok: true, outcome: 'added' });
    expect(await roleOf(B.id, ids.LONELY)).toBe('staff');
    const promote = await request(tokens.admin, `/admin/businesses/${B.id}/members/${ids.LONELY}`, {
      company: A.id,
      method: 'PUT',
      body: { role: 'owner' },
    });
    expect(promote.status).toBe(200);
    expect(await roleOf(B.id, ids.LONELY)).toBe('owner');
    const inB = await actions(B.id);
    expect(inB).toContain(`admin.team.member_added ${ids.LONELY}`);
    expect(inB).toContain(`admin.team.role_owner ${ids.LONELY}`);
    expect((await actions(A.id)).filter((a) => a.startsWith('admin.'))).toEqual([]);
    for (const company of [A, B])
      expect(
        (await actions(company.id)).filter((a) => /^(POST|PUT|DELETE) \/api\/admin/.test(a)),
      ).toEqual([]);
  });

  it('answers 404 for a missing business or a person who is not in it', async () => {
    const missing = await request(tokens.admin, `/admin/businesses/${B.id}/members/${ids.STAFF}`, {
      method: 'PUT',
      body: { role: 'owner' },
    });
    expect(missing.status).toBe(404);
    expect(await roleOf(B.id, ids.STAFF)).toBeUndefined();
    const nowhere = await request(tokens.admin, '/admin/businesses/no-such-business/members', {
      body: { email: 'lonely@example.com', role: 'staff' },
    });
    expect(nowhere.status).toBe(404);
  });
});

describe('deleting an account', () => {
  const remove = (token: string, userId: string) =>
    request(token, `/admin/accounts/${userId}`, { method: 'DELETE' });

  it('needs the authenticator, and refuses yourself, other admins and bad IDs', async () => {
    const deleteAccount = vi.spyOn(repo, 'deleteAccount');
    const plain = await remove(tokens.admin, ids.STAFF);
    expect(plain.status).toBe(403);
    expect(((await plain.json()) as { error: string }).error).toContain('authenticator');
    expect((await remove(tokens.adminMfa, ids.ADMIN)).status).toBe(409);
    await repo.addAccount({ userId: ids.SECOND_ADMIN, email: 'second@example.com' });
    await repo.grantAdmin(ids.SECOND_ADMIN);
    expect((await remove(tokens.adminMfa, ids.SECOND_ADMIN)).status).toBe(409);
    expect((await remove(tokens.adminMfa, 'not-a-uuid')).status).toBe(400);
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it('removes the person everywhere and records it in their business', async () => {
    const res = await remove(tokens.adminMfa, ids.STAFF);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removedFrom: 1 });
    expect(await roleOf(A.id, ids.STAFF)).toBeUndefined();
    expect((await repo.listAccounts()).some((a) => a.email === 'staff@example.com')).toBe(false);
    // In production getUser also fails for a deleted account, which answers 401.
    expect((await request(tokens.staff, '/bootstrap')).status).toBe(403);
    expect(await actions(A.id)).toContain(`admin.account_deleted ${ids.STAFF}`);
    expect((await remove(tokens.adminMfa, ids.STAFF)).status).toBe(404);
  });

  it('records deleting an account with no business outside any business', async () => {
    const res = await remove(tokens.adminMfa, ids.LONELY);
    expect(await res.json()).toEqual({ ok: true, removedFrom: 0 });
    expect(platformAudit()).toEqual([
      expect.objectContaining({ action: `admin.account_deleted ${ids.LONELY}` }),
    ]);
  });

  it('reports success when only the record failed after the deletion', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(repo, 'audit').mockRejectedValue(new Error('audit down'));
    const res = await remove(tokens.adminMfa, ids.STAFF);
    expect(res.status).toBe(200);
    expect((await repo.listAccounts()).some((a) => a.userId === ids.STAFF)).toBe(false);
  });
});
