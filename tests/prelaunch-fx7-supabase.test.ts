// api-security-4: in live mode, deleting a customer's data (or disconnecting) while work is
// running answers the database's own reason with 409, as the local store does, instead of a
// general failure. The hosted store, without a network.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SupabaseRepository } from '../server/storage/supabase';
import { PublicError } from '../server/security';

const client = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), auth: { admin: {} } }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => client }));

let repo: SupabaseRepository;
beforeEach(() => {
  repo = new SupabaseRepository('https://x.supabase.co', 'k');
});
afterEach(() => {
  vi.resetAllMocks();
});
// As PostgREST reports a plpgsql raise exception.
const raised = (message: string) => ({ data: null, error: { code: 'P0001', message } });

describe('api-security-4: work still running', () => {
  it.each([
    ['erase_customer', () => repo.eraseCustomer('c1', '923001234567')],
    ['erase_conversation', () => repo.eraseConversation('c1', 'chat-1')],
  ])('%s says to pause and wait (409)', async (name, erase) => {
    client.rpc.mockResolvedValue(
      raised('Pause automation and wait for running work before deleting customer data'),
    );
    const error = await erase().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PublicError);
    expect(error).toMatchObject({
      status: 409,
      message: 'Pause automation and wait for running work before deleting customer data.',
    });
    expect(client.rpc).toHaveBeenCalledWith(name, expect.any(Object));
  });

  it('says to wait before disconnecting (409)', async () => {
    client.rpc.mockResolvedValue(raised('Wait for running work before disconnecting'));
    await expect(repo.disconnectIntegration('c1', 'whatsapp')).rejects.toMatchObject({
      status: 409,
      message: 'Wait for running jobs to finish before disconnecting.',
    });
  });

  it('keeps the answers and other failures as before', async () => {
    client.rpc.mockResolvedValue({ data: 2, error: null });
    expect(await repo.eraseCustomer('c1', '923001234567')).toBe(2);
    expect(await repo.eraseConversation('c1', 'chat-1')).toBe(2);
    client.rpc.mockResolvedValue({ data: null, error: null });
    await expect(repo.disconnectIntegration('c1', 'sheets')).resolves.toBeUndefined();
    client.rpc.mockResolvedValue({ data: null, error: { code: '57014', message: 'timeout' } });
    await expect(repo.eraseCustomer('c1', '923001234567')).rejects.toThrow(
      'Database operation failed',
    );
    await expect(repo.disconnectIntegration('c1', 'sheets')).rejects.toThrow(
      'Database operation failed',
    );
    client.rpc.mockResolvedValue(raised('Customer phone number required'));
    await expect(repo.eraseCustomer('c1', ' ')).rejects.not.toBeInstanceOf(PublicError);
  });
});
