import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { Repository } from './repository';
import type { AppEnv } from './management';
import type {
  Account,
  Company,
  DeletedBusiness,
  Membership,
  PeopleDirectory,
} from '../src/shared/types';
import { sameTypedName } from '../src/shared/slug.js';
import { BUSINESS_BUSY, PAUSE_BOT_FIRST, PublicError } from './security';
import { appMode, PLATFORM_AUDIT_ID } from './config';
import { addMemberByEmail } from './team';
import { gatewayAvailable } from './whatsapp/client';
import { disconnectGateway } from './whatsapp/connections';

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
  // sets it; owners cannot. A revoke stops every further pairing, including for a business from
  // before approvals existed; its current session keeps running until it is disconnected or the
  // business switches to the official Meta route (see pairingAllowed in whatsapp/routes.ts).
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
  // Deletes a whole business for good, as the runbook's workspace deletion did by hand: its menu,
  // deals, chats, orders, settings and connections. The admin types its name; its bot must be
  // paused, and a linked phone is logged out on the gateway first, so it does not stay linked
  // there. Its people stay, without access to it.
  app.delete('/businesses/:companyId', async (c) => {
    const id = companyId.parse(c.req.param('companyId'));
    const actorId = c.get('userId');
    // Irreversible, so it needs the authenticator, as deleting an account does.
    if (!c.get('mfaVerified'))
      throw new PublicError(
        'Turn on authenticator protection in Security & privacy before deleting businesses.',
        403,
      );
    if (!(await repo.consumeRateLimit(`admin-delete-business:${actorId}`, 10)))
      throw new PublicError('Please wait a minute before deleting more businesses.', 429);
    const { name } = z
      .object({ name: z.string().max(200) })
      .strict()
      .parse(await c.req.json());
    const stored = await repo.getCompany(id);
    if (!stored) throw new PublicError('Business not found.', 404);
    // Spaces, curly apostrophes and Unicode forms aren't counted, as on the page (sameTypedName).
    if (!sameTypedName(name, stored.name))
      throw new PublicError('Type the business name exactly to delete it.', 400);
    // The dashboard would be left showing a business that is gone.
    if (c.get('company').id === id)
      throw new PublicError('Open another business first, then delete this one.', 409);
    if (stored.botEnabled) throw new PublicError(PAUSE_BOT_FIRST, 409);
    // Everything that can still refuse is asked before WhatsApp is touched, so a refusal here
    // (running work, or the migration not applied yet) leaves the linked phone as it was.
    await repo.checkCompanyDeletable(id, stored.slug);
    // A linked phone is logged out first. Once the business is gone its session's events are
    // answered 410 (isDeletedConnection), but a session that sends nothing would never hear it.
    const linked = (await repo.getWhatsAppConnection(id))?.provider === 'baileys';
    if (linked) {
      // Switched off, the gateway can't be told and its events aren't read (they get a 503), so
      // a retry can't help until it is back on.
      if (!gatewayAvailable())
        throw new PublicError(
          'The linked-phone service is switched off, so Orderly can’t log out this business’s linked phone. Turn the linked-phone service back on first, then delete the business.',
          409,
        );
      if ((await disconnectGateway(repo, id)).gatewayCleanupPending)
        throw new PublicError(
          'Orderly disconnected WhatsApp but couldn’t log out the linked phone yet, so the business was not deleted. Try again in a few minutes.',
          409,
        );
    }
    const [memberships, adminIds] = await Promise.all([
      repo.listAllMemberships(),
      repo.listAdminIds(),
    ]);
    let removed: DeletedBusiness;
    try {
      removed = await repo.deleteCompany(id, stored.slug, actorId);
    } catch (error) {
      // Work started after the check, and WhatsApp is already off: don't say nothing changed.
      if (linked && error instanceof PublicError && error.message === BUSINESS_BUSY)
        throw new PublicError(
          'Orderly disconnected WhatsApp, but it is still working on messages for this business, so the business was not deleted. Wait a minute, then try again.',
          409,
        );
      throw error;
    }
    const peopleLeftWithoutBusiness = memberships.filter(
      (m) =>
        m.companyId === id &&
        !adminIds.includes(m.userId) &&
        !memberships.some((o) => o.userId === m.userId && o.companyId !== id),
    ).length;
    // The business is gone; a failed record must not turn this into an error that a retry would
    // answer with "not found". delete_company records it under the business's id too.
    try {
      await repo.audit(PLATFORM_AUDIT_ID, actorId, `admin.business_deleted ${id}`);
    } catch {
      console.warn('Orderly: admin audit failed after a business deletion.');
    }
    return c.json({ ok: true, removed, peopleLeftWithoutBusiness });
  });
  return app;
}
