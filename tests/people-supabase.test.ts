import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SupabaseRepository } from '../server/storage/supabase';
import { LAST_OWNER_MESSAGE, PublicError, sanitizeError } from '../server/security';

const client = vi.hoisted(() => ({
  auth: {
    admin: {
      listUsers: vi.fn(),
      getUserById: vi.fn(),
      deleteUser: vi.fn(),
      inviteUserByEmail: vi.fn(),
    },
  },
  rpc: vi.fn(),
  from: vi.fn(),
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => client }));

const admin = client.auth.admin;
const user = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  email: `person${n}@example.com`,
  created_at: '2026-09-01T00:00:00.000Z',
  last_sign_in_at: '2026-10-15T09:00:00.000Z',
  ...extra,
});
const page = (users: unknown[], nextPage: number | null) => ({
  data: { users, aud: 'authenticated', nextPage, lastPage: 0, total: 0 },
  error: null,
});
let repo: SupabaseRepository;

beforeEach(() => {
  vi.stubEnv('APP_URL', 'https://orderly.example');
  repo = new SupabaseRepository('https://x.supabase.co', 'k');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as Error & { status?: number };
  }
  throw new Error('Expected a failure');
}

describe('account paging and lookup', () => {
  it('follows nextPage only as a yes/no flag and maps the account fields', async () => {
    admin.listUsers
      .mockResolvedValueOnce(page([user(1)], 2))
      .mockResolvedValueOnce(
        page([user(2, { last_sign_in_at: null, invited_at: '2026-10-01T00:00:00.000Z' })], null),
      );
    expect(await repo.listAccounts()).toEqual([
      {
        userId: user(1).id,
        email: 'person1@example.com',
        createdAt: '2026-09-01T00:00:00.000Z',
        lastSignInAt: '2026-10-15T09:00:00.000Z',
        invited: false,
      },
      {
        userId: user(2).id,
        email: 'person2@example.com',
        createdAt: '2026-09-01T00:00:00.000Z',
        lastSignInAt: undefined,
        invited: true,
      },
    ]);
    expect(admin.listUsers.mock.calls).toEqual([
      [{ page: 1, perPage: 1000 }],
      [{ page: 2, perPage: 1000 }],
    ]);
  });

  it('stops on an empty page even when Supabase says there is more', async () => {
    admin.listUsers.mockResolvedValueOnce(page([user(1)], 2)).mockResolvedValueOnce(page([], 3));
    expect(await repo.listAccounts()).toHaveLength(1);
    expect(admin.listUsers).toHaveBeenCalledTimes(2);
  });

  it('turns Auth errors and network failures into a friendly 502', async () => {
    admin.listUsers.mockResolvedValueOnce({ data: { users: [] }, error: { message: 'boom' } });
    const returned = await failure(repo.listAccounts());
    expect(returned).toBeInstanceOf(PublicError);
    expect(returned.status).toBe(502);
    admin.listUsers.mockRejectedValueOnce(new TypeError('fetch failed'));
    const thrown = await failure(repo.listAccounts());
    expect(thrown).toBeInstanceOf(PublicError);
    expect(thrown.status).toBe(502);
  });

  it('gives up with 413 after 20 full pages', async () => {
    admin.listUsers.mockResolvedValue(page([user(1)], 2));
    const error = await failure(repo.listAccounts());
    expect(error).toBeInstanceOf(PublicError);
    expect(error.status).toBe(413);
    expect(admin.listUsers).toHaveBeenCalledTimes(20);
  });

  it('finds an account by email, ignoring case and spaces', async () => {
    admin.listUsers.mockResolvedValue(page([user(1), user(2)], null));
    expect((await repo.findAccountByEmail('  PERSON2@Example.com '))?.userId).toBe(user(2).id);
    expect(await repo.findAccountByEmail('nobody@example.com')).toBeUndefined();
  });

  it('reads team accounts one by one, skipping any that fail', async () => {
    admin.getUserById.mockImplementation(async (id: string) => {
      if (id === user(2).id) return { data: { user: null }, error: { message: 'not found' } };
      if (id === user(3).id) throw new Error('network');
      return { data: { user: user(Number(id.slice(-12))) }, error: null };
    });
    const accounts = await repo.getAccounts([user(1).id, user(1).id, user(2).id, user(3).id]);
    expect(accounts.map((a) => a.userId)).toEqual([user(1).id]);
    expect(admin.getUserById).toHaveBeenCalledTimes(3);
    expect(await repo.getAccounts([])).toEqual([]);
  });

  it('lists all accounts instead for teams over 25 people', async () => {
    admin.listUsers.mockResolvedValue(page([user(1), user(40)], null));
    const ids = Array.from({ length: 30 }, (_, i) => user(i + 1).id);
    const accounts = await repo.getAccounts(ids);
    expect(accounts.map((a) => a.userId)).toEqual([user(1).id]);
    expect(admin.getUserById).not.toHaveBeenCalled();
  });
});

describe('membership errors and account writes', () => {
  it('turns the last-owner rule into a friendly 409', async () => {
    client.rpc.mockResolvedValue({
      data: null,
      error: { code: 'P0001', message: 'Keep another owner and do not remove or demote yourself' },
    });
    for (const attempt of [
      () => repo.setMember('company', { userId: user(1).id, role: 'staff' }, user(2).id),
      () => repo.removeMember('company', user(1).id, user(2).id),
    ]) {
      const error = await failure(attempt());
      expect(error).toBeInstanceOf(PublicError);
      expect(error.status).toBe(409);
      expect(error.message).toBe(LAST_OWNER_MESSAGE);
    }
    expect(client.rpc).toHaveBeenCalledWith('manage_member', {
      p_company_id: 'company',
      p_user_id: user(1).id,
      p_role: null,
      p_actor_id: user(2).id,
    });
  });

  it('answers 404 for an account ID that does not exist, and hides other errors', async () => {
    client.rpc.mockResolvedValueOnce({ data: null, error: { code: '23503', message: 'fk' } });
    const missing = await failure(
      repo.setMember('company', { userId: user(1).id, role: 'staff' }, user(2).id),
    );
    expect(missing).toBeInstanceOf(PublicError);
    expect(missing.status).toBe(404);
    client.rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'secret' } });
    const other = await failure(
      repo.setMember('company', { userId: user(1).id, role: 'staff' }, user(2).id),
    );
    expect(other).not.toBeInstanceOf(PublicError);
    expect(sanitizeError(other)).not.toContain('secret');
    client.rpc.mockResolvedValueOnce({ data: null, error: null });
    await expect(
      repo.setMember('company', { userId: user(1).id, role: 'owner' }, user(2).id),
    ).resolves.toBeUndefined();
  });

  it('hard-deletes accounts and explains failures', async () => {
    admin.deleteUser.mockResolvedValueOnce({ data: { user: null }, error: null });
    await repo.deleteAccount(user(1).id);
    expect(admin.deleteUser.mock.calls).toEqual([[user(1).id]]);
    admin.deleteUser.mockResolvedValueOnce({
      data: { user: null },
      error: { status: 404, message: 'User not found' },
    });
    expect((await failure(repo.deleteAccount(user(1).id))).status).toBe(404);
    admin.deleteUser.mockResolvedValueOnce({
      data: { user: null },
      error: { status: 500, message: 'Database error deleting user' },
    });
    const failed = await failure(repo.deleteAccount(user(1).id));
    expect(failed).toBeInstanceOf(PublicError);
    expect(failed.status).toBe(502);
    admin.deleteUser.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect((await failure(repo.deleteAccount(user(1).id))).status).toBe(502);
  });

  it('sends invitations back to the sign-in page', async () => {
    admin.inviteUserByEmail.mockResolvedValueOnce({ data: { user: user(9) }, error: null });
    expect(await repo.inviteAccount(' new@example.com ')).toBe(user(9).id);
    expect(admin.inviteUserByEmail).toHaveBeenCalledWith('new@example.com', {
      redirectTo: 'https://orderly.example/login',
    });
    admin.inviteUserByEmail.mockResolvedValueOnce({
      data: { user: null },
      error: { message: 'Email rate limit exceeded' },
    });
    const error = await failure(repo.inviteAccount('new@example.com'));
    expect(error).toBeInstanceOf(PublicError);
    expect(error.status).toBe(409);
  });

  it('pages through every membership', async () => {
    const range = vi.fn();
    const rows = (n: number, offset: number) =>
      Array.from({ length: n }, (_, i) => ({
        company_id: 'company',
        user_id: user(offset + i).id,
        role: 'staff',
      }));
    range
      .mockResolvedValueOnce({ data: rows(1000, 0), error: null })
      .mockResolvedValueOnce({ data: rows(3, 1000), error: null });
    const order = vi.fn(() => ({ order: () => ({ range }) }));
    client.from.mockReturnValue({ select: () => ({ order }) });
    const memberships = await repo.listAllMemberships();
    expect(memberships).toHaveLength(1003);
    expect(memberships[1002]).toEqual({
      companyId: 'company',
      userId: user(1002).id,
      role: 'staff',
    });
    expect(range.mock.calls).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    expect(client.from).toHaveBeenCalledWith('company_memberships');
  });

  it('lists platform admin IDs', async () => {
    client.from.mockReturnValue({
      select: async () => ({ data: [{ user_id: user(1).id }], error: null }),
    });
    expect(await repo.listAdminIds()).toEqual([user(1).id]);
    expect(client.from).toHaveBeenCalledWith('platform_admins');
  });
});
