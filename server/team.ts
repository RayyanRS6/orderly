import type { Repository } from './repository';
import type { AddMemberOutcome } from '../src/shared/types';
import { PublicError } from './security';
import { appMode } from './config';

/**
 * Adds a person to a business by email: an existing account straight away, otherwise (live
 * only) a Supabase invitation. Shared by owners' Team access and the admin's People page.
 */
export async function addMemberByEmail(
  repo: Repository,
  companyId: string,
  email: string,
  role: 'owner' | 'staff',
  actorId: string,
): Promise<{ userId: string; outcome: AddMemberOutcome }> {
  const account = await repo.findAccountByEmail(email);
  if (account) {
    if (await repo.isAdmin(account.userId))
      throw new PublicError(
        'This is the Orderly admin. They can already open every business.',
        409,
      );
    if ((await repo.listMembers(companyId)).some((m) => m.userId === account.userId))
      throw new PublicError(
        'This person is already in this business. Change their role in the list instead.',
        409,
      );
    await repo.setMember(companyId, { userId: account.userId, role }, actorId);
    return { userId: account.userId, outcome: account.lastSignInAt ? 'added' : 'added_waiting' };
  }
  if (appMode() !== 'live')
    throw new PublicError(
      'No account uses this email yet. Invitations need the hosted workspace.',
      409,
    );
  // If adding fails after the invitation, the account shows on People under
  // "Not in any business yet", as with the earlier invitation flow.
  const userId = await repo.inviteAccount(email);
  await repo.setMember(companyId, { userId, role }, actorId);
  return { userId, outcome: 'invited' };
}
