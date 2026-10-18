import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { Repository } from './repository';
import type { AppEnv } from './management';
import type { Account, Company, Membership, PeopleDirectory } from '../src/shared/types';
import { PublicError } from './security';
import { appMode, PLATFORM_AUDIT_ID } from './config';
import { addMemberByEmail } from './team';

/** Only the platform admin. Checked on every request; the role set for the open business is not trusted. */
export const requireAdmin =
  (repo: Repository): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    if (appMode() !== 'demo' && !(await repo.isAdmin(c.get('userId'))))
      throw new PublicError('Only the Orderly admin can manage people.', 403);
    await next();
  };

/** Everyone who can sign in, with their businesses. Accounts are undefined when Auth was unreadable. */
export function buildPeopleDirectory(
  companies: Company[],
  memberships: Membership[],
  accounts: Account[] | undefined,
  adminIds: string[],
  viewerId: string,
  canDeleteAccounts: boolean,
): PeopleDirectory {
  const byId = new Map((accounts ?? []).map((a) => [a.userId, { ...a }]));
  // Members and admins whose account could not be read still show, by account ID.
  for (const userId of [...memberships.map((m) => m.userId), ...adminIds])
    if (!byId.has(userId)) byId.set(userId, { userId });
  const admins = new Set(adminIds);
  return {
    businesses: companies
      .map((b) => ({ id: b.id, name: b.name, slug: b.slug }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    accounts: [...byId.values()]
      .map((a) => ({
        ...a,
        admin: admins.has(a.userId),
        ...(a.userId === viewerId && { you: true }),
        memberships: memberships
          .filter((m) => m.userId === a.userId)
          .map((m) => ({ companyId: m.companyId, role: m.role })),
      }))
      .sort(
        (a, b) => (a.email ?? '').localeCompare(b.email ?? '') || a.userId.localeCompare(b.userId),
      ),
    ...(accounts === undefined && { emailsUnavailable: true }),
    canDeleteAccounts,
  };
}

export function adminRoutes(repo: Repository) {
  const app = new Hono<AppEnv>();
  app.use('*', requireAdmin(repo));
  const companyId = z.string().min(1).max(100);
  const roleBody = z.object({ role: z.enum(['owner', 'staff']) }).strict();
  const business = async (id: string) => {
    if (!(await repo.getCompany(id))) throw new PublicError('Business not found.', 404);
  };
  const member = async (id: string, userId: string) => {
    await business(id);
    if (!(await repo.listMembers(id)).some((m) => m.userId === userId))
      throw new PublicError('This person isn’t in this business any more.', 404);
  };
  app.get('/people', async (c) => {
    const [companies, memberships, accounts, adminIds] = await Promise.all([
      repo.listCompanies(),
      repo.listAllMemberships(),
      repo.listAccounts().catch(() => undefined),
      repo.listAdminIds(),
    ]);
    const directory = buildPeopleDirectory(
      companies,
      memberships,
      accounts,
      adminIds,
      c.get('userId'),
      c.get('mfaVerified'),
    );
    await repo.audit(PLATFORM_AUDIT_ID, c.get('userId'), 'admin.people_viewed');
    c.header('Cache-Control', 'no-store');
    return c.json(directory);
  });
  app.post('/businesses/:companyId/members', async (c) => {
    const id = companyId.parse(c.req.param('companyId'));
    const { email, role } = z
      .object({
        email: z.string().trim().pipe(z.email().max(254)),
        role: z.enum(['owner', 'staff']),
      })
      .strict()
      .parse(await c.req.json());
    await business(id);
    if (!(await repo.consumeRateLimit(`admin-add:${c.get('userId')}`, 30)))
      throw new PublicError('Please wait a minute before adding more people.', 429);
    const r = await addMemberByEmail(repo, id, email, role, c.get('userId'));
    await repo.audit(
      id,
      c.get('userId'),
      `admin.team.${r.outcome === 'invited' ? 'invited' : 'member_added'} ${r.userId}`,
    );
    return c.json({ ok: true, outcome: r.outcome });
  });
  app.put('/businesses/:companyId/members/:userId', async (c) => {
    const id = companyId.parse(c.req.param('companyId'));
    const userId = z.string().uuid().parse(c.req.param('userId'));
    const { role } = roleBody.parse(await c.req.json());
    await member(id, userId);
    await repo.setMember(id, { userId, role }, c.get('userId'));
    await repo.audit(id, c.get('userId'), `admin.team.role_${role} ${userId}`);
    return c.json({ ok: true });
  });
  // Whether this business may pair a new linked phone (the unofficial route). Only the admin
  // sets it; owners cannot. A business already on a linked phone keeps it either way.
  app.put('/businesses/:companyId/linked-device', async (c) => {
    const id = companyId.parse(c.req.param('companyId'));
    const { allowed } = z
      .object({ allowed: z.boolean() })
      .strict()
      .parse(await c.req.json());
    const stored = await repo.getCompany(id);
    if (!stored) throw new PublicError('Business not found.', 404);
    await repo.saveCompany({ ...stored, linkedDeviceAllowed: allowed });
    await repo.audit(id, c.get('userId'), `admin.linked_device.${allowed ? 'allowed' : 'revoked'}`);
    return c.json({ ok: true, linkedDeviceAllowed: allowed });
  });
  app.delete('/businesses/:companyId/members/:userId', async (c) => {
    const id = companyId.parse(c.req.param('companyId'));
    const userId = z.string().uuid().parse(c.req.param('userId'));
    await member(id, userId);
    await repo.removeMember(id, userId, c.get('userId'));
    await repo.audit(id, c.get('userId'), `admin.team.member_removed ${userId}`);
    return c.json({ ok: true });
  });
  app.delete('/accounts/:userId', async (c) => {
    const userId = z.string().uuid().parse(c.req.param('userId'));
    const actorId = c.get('userId');
    if (userId === actorId) throw new PublicError('You can’t delete your own account here.', 409);
    if (await repo.isAdmin(userId))
      throw new PublicError(
        'This is a platform admin. Remove admin access in Supabase first.',
        409,
      );
    // Irreversible and platform-wide, so it needs the authenticator even though signing in
    // without one is allowed.
    if (!c.get('mfaVerified'))
      throw new PublicError(
        'Turn on authenticator protection in Security & privacy before deleting accounts.',
        403,
      );
    if (!(await repo.consumeRateLimit(`admin-delete:${actorId}`, 10)))
      throw new PublicError('Please wait a minute before deleting more accounts.', 429);
    const businesses = (await repo.listAllMemberships())
      .filter((m) => m.userId === userId)
      .map((m) => m.companyId);
    await repo.deleteAccount(userId);
    // The account is gone; a failed record must not turn this into an error that a retry
    // would answer with "not found".
    try {
      for (const id of businesses.length ? businesses : [PLATFORM_AUDIT_ID])
        await repo.audit(id, actorId, `admin.account_deleted ${userId}`);
    } catch {
      console.warn('Orderly: admin audit failed after an account deletion.');
    }
    return c.json({ ok: true, removedFrom: businesses.length });
  });
  return app;
}
