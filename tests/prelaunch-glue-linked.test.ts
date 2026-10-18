// The linked phone and the Meta route agree: captions and locations worded alike (F01), the
// status check that asks the gateway only when needed (F25, F06), the connection lock's lease
// (F05), and a WhatsApp account another business has (F24).
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ACCOUNT_IN_USE, PublicError } from '../server/security';
import { SupabaseRepository } from '../server/storage/supabase';
import { metaInboundContent } from '../server/whatsapp/inbound';
import { withConnectionLock } from '../server/whatsapp/connections';
import { seedCompanies } from '../src/shared/seed';
import { captionText, locationText } from '../src/shared/whatsapp';
import { company, demoApp, linkedPhone, minutesAgo, storeConnection } from './helpers/demo-app';

const client = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), auth: { admin: {} } }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => client }));

const app = demoApp();

describe('captions and locations on the Meta route (F01)', () => {
  it('words them exactly as the linked phone does', () => {
    for (const [type, media] of [
      ['image', 'photo'],
      ['video', 'video'],
      ['document', 'document'],
    ] as const)
      for (const caption of ['2 biryani please', 'دو بریانی اور ایک نان', ' menu\n2 naan '])
        expect(metaInboundContent({ type, [type]: { caption } })).toEqual({
          text: captionText(caption, media),
        });
    for (const pin of [
      { latitude: 31.5204, longitude: 74.3587, name: 'Home', address: 'House 5, Gulberg III' },
      { latitude: 24.8607, longitude: 67.0011 },
      { name: 'F-7 Markaz', address: 'F-7 Markaz' },
      { latitude: 33.68441234, longitude: 73.0479, address: '  Blue   Area  ' },
    ])
      expect(metaInboundContent({ type: 'location', location: pin })).toEqual({
        text: locationText(pin),
      });
  });
});

describe('the linked-phone status check (F25, F06)', () => {
  const check = () => app.request('/whatsapp/pairing-status', { body: {} });
  const audited = async () =>
    (await app.repo().listTraces(company.id)).filter((t) => t.action.includes('pairing-status'));

  it('answers from the stored connection while a connected phone reports, without asking the gateway', async () => {
    const stored = await storeConnection(app.repo(), { status: 'connected' });
    const response = await check();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      connection: stored,
      snapshot: { connectionId: stored.id, generation: stored.generation, status: 'connected' },
    });
    expect(fetch).not.toHaveBeenCalled();
    // Silent for over 3 minutes: the gateway is asked (and here, switched off, it cannot answer).
    await storeConnection(app.repo(), { status: 'connected', lastHeartbeatAt: minutesAgo(4) });
    expect((await check()).status).toBe(503);
    // So is a phone still pairing.
    await storeConnection(app.repo(), { status: 'awaiting_pairing', accountJid: undefined });
    expect((await check()).status).toBe(503);
    // Status checks are not changes: nothing is written to the audit log.
    expect(await audited()).toEqual([]);
  });

  it('allows about 40 checks a minute for a business', async () => {
    await storeConnection(app.repo(), { status: 'connected' });
    for (let i = 0; i < 40; i++) expect((await check()).status).toBe(200);
    const limited = await check();
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
  });
});

describe('the WhatsApp connection lock (F05)', () => {
  it('lasts one worker lease, not eight minutes', async () => {
    const repo = app.repo();
    const acquire = vi.spyOn(repo, 'acquireConversationLock');
    await withConnectionLock(repo, company.id, async () => 'done');
    const lease = (call: number) => Date.parse(String(acquire.mock.calls[call]![3])) - Date.now();
    expect(lease(0)).toBeGreaterThan(170_000);
    expect(lease(0)).toBeLessThanOrEqual(180_000);
    vi.stubEnv('WORKER_LEASE_SECONDS', '480');
    await withConnectionLock(repo, company.id, async () => 'done');
    expect(lease(1)).toBeGreaterThan(470_000);
    expect(lease(1)).toBeLessThanOrEqual(480_000);
  });
});

describe('a WhatsApp account another business has connected (F24)', () => {
  it('is refused by the local store with a 409', async () => {
    await storeConnection(app.repo(), { status: 'connected' });
    const other = seedCompanies[1]!;
    const error = await app
      .repo()
      .saveWhatsAppConnection(
        { ...linkedPhone(), id: randomUUID(), companyId: other.id, revision: 1 },
        0,
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PublicError);
    expect(error).toMatchObject({ status: 409, message: ACCOUNT_IN_USE });
  });

  it('is refused by the hosted store the same way, from the unique index', async () => {
    const hosted = new SupabaseRepository('https://x.supabase.co', 'k');
    client.rpc.mockResolvedValue({
      data: null,
      error: {
        code: '23505',
        message: 'duplicate key value violates unique constraint "whatsapp_account_unique"',
      },
    });
    const error = await hosted.saveWhatsAppConnection(linkedPhone(), 0).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PublicError);
    expect(error).toMatchObject({ status: 409, message: ACCOUNT_IN_USE });
    // Any other database error is left as it was.
    client.rpc.mockResolvedValue({
      data: null,
      error: { code: '23505', message: 'duplicate key value violates unique constraint "other"' },
    });
    await expect(hosted.saveWhatsAppConnection(linkedPhone(), 0)).rejects.toThrow(
      'Database operation failed',
    );
    client.rpc.mockResolvedValue({ data: true, error: null });
    expect(await hosted.saveWhatsAppConnection(linkedPhone(), 0)).toBe(true);
  });
});
