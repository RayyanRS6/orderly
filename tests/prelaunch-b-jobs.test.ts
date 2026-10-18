import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MemoryRepository } from '../server/repository';
import { encryptSecret } from '../server/security';
import { processJob } from '../server/service';
import { makeJob } from '../server/jobs';
import { workerLeaseMs } from '../server/config';
import { jobAddress, saveConnection } from '../server/whatsapp/connections';
import { createConversation, processTurn } from '../src/domain/engine';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import type { BotAction, Conversation, Job, Order } from '../src/shared/types';
import type { WhatsAppAddress, WhatsAppConnection } from '../src/shared/whatsapp';

const company = seedCompanies[0]!;
const products = seedProducts.filter((p) => p.companyId === company.id);
const secret = 'gateway-test-secret-with-more-than-32-characters';
let repo: MemoryRepository;

beforeEach(() => {
  repo = new MemoryRepository();
  vi.stubEnv('APP_MODE', 'demo');
  vi.stubEnv('ORDERLY_RUNTIME', '');
  vi.stubEnv('VERCEL', '');
  vi.stubEnv('WORKER_LEASE_SECONDS', '');
  vi.stubEnv('ORDERLY_PAUSE_AUTOMATION', '');
  vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const incoming = (phone: string, text: string, attempts = 0): Job => ({
  ...makeJob(company.id, 'incoming', { phone, messageId: `wamid-${randomUUID()}`, text }),
  attempts,
});
const chatOf = async (phone: string) =>
  (await repo.findConversation(company.id, phone, 'whatsapp'))!;

describe('F17: a message that fails for good no longer holds back the customer', () => {
  it('puts the message in the chat for staff and lets later messages through', async () => {
    const phone = '923005500001';
    const chat = {
      ...createConversation(company.id, phone, 'whatsapp', new Date().toISOString()),
      version: 1,
    };
    await repo.saveConversation(chat, 0);
    const failing = incoming(phone, 'cancel my order please', 4);
    await repo.insertJob(failing);
    const later = incoming(phone, 'hello? anyone');
    await repo.insertJob(later);
    vi.spyOn(repo, 'commitTurn').mockRejectedValueOnce(new Error('Database unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await processJob(repo, failing.id);
    expect((await repo.getJob(failing.id))!).toMatchObject({
      status: 'done',
      payload: { failedPermanently: true },
      error: 'Integration failed; check its credentials and service health.',
    });
    let saved = await chatOf(phone);
    expect(saved.mode).toBe('human');
    expect(saved.messages.at(-1)).toMatchObject({
      id: failing.payload.messageId,
      role: 'customer',
      text: 'cancel my order please',
    });
    expect(
      (await repo.listTraces(company.id)).find((t) => t.action === 'job.failed'),
    ).toMatchObject({
      conversationId: chat.id,
    });
    // The next message is no longer stuck behind it: it is recorded for staff, unanswered.
    await processJob(repo, later.id);
    expect((await repo.getJob(later.id))!.status).toBe('done');
    saved = await chatOf(phone);
    expect(saved.messages.at(-1)).toMatchObject({ role: 'customer', text: 'hello? anyone' });
    expect(saved.mode).toBe('human');
    expect(
      (await repo.listCompanyJobs(company.id)).filter((j) => j.kind === 'whatsapp_send'),
    ).toEqual([]);
  });

  it('starts the chat when the customer’s first message failed', async () => {
    const phone = '923005500002';
    const failing = incoming(phone, 'first message', 5);
    await repo.insertJob(failing);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await processJob(repo, failing.id);
    expect((await repo.getJob(failing.id))!.status).toBe('done');
    const saved = await chatOf(phone);
    expect(saved.mode).toBe('human');
    expect(saved.messages.map((m) => m.text)).toEqual(['first message']);
  });

  it('stays a barrier when the chat cannot be saved', async () => {
    const phone = '923005500003';
    const failing = incoming(phone, 'first message', 5);
    await repo.insertJob(failing);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(repo, 'saveConversation').mockResolvedValue(false);
    await processJob(repo, failing.id);
    expect((await repo.getJob(failing.id))!.status).toBe('failed');
  });
});

describe('F50: one log line per failed job, without customer data', () => {
  it('logs the job, kind, tries and cause, never the text or the number', async () => {
    const phone = '923005500004';
    const failing = incoming(phone, 'my address is House 4, call 03001234567', 1);
    await repo.insertJob(failing);
    vi.spyOn(repo, 'commitTurn').mockRejectedValueOnce(
      new Error('insert failed for customer 923005500004 with Bearer abc.def.ghi'),
    );
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(processJob(repo, failing.id)).rejects.toMatchObject({ status: 503 });
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]![0]);
    expect(JSON.parse(line)).toEqual({
      event: 'job_failed',
      jobId: failing.id,
      kind: 'incoming',
      companyId: company.id,
      attempts: 2,
      permanent: false,
      error: 'Error: insert failed for customer [number] with Bearer [redacted]',
    });
    expect(line).not.toContain('House 4');
    expect(line).not.toContain(phone);
  });
});

describe('F134: worker leases fit the Supabase plan', () => {
  const leaseOf = async () => {
    const claim = vi.spyOn(repo, 'claimJob');
    await processJob(repo, 'no-such-job');
    const [, now, until] = claim.mock.calls.at(-1)!;
    return Date.parse(until) - Date.parse(now);
  };
  it('defaults to 180 s for the Free plan and reads WORKER_LEASE_SECONDS', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-18T10:00:00.000Z'));
    expect(await leaseOf()).toBe(180_000);
    vi.stubEnv('WORKER_LEASE_SECONDS', '480');
    expect(await leaseOf()).toBe(480_000);
    for (const bad of ['abc', '30', '5000', '90.5']) {
      vi.stubEnv('WORKER_LEASE_SECONDS', bad);
      expect(workerLeaseMs()).toBe(180_000);
    }
  });
});

describe('WhatsApp sends on the linked device', () => {
  let connection: WhatsAppConnection;
  let address: WhatsAppAddress;
  let fetch: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    vi.stubEnv('APP_MODE', 'live');
    vi.stubEnv('WHATSAPP_GATEWAY_ENABLED', 'true');
    vi.stubEnv('WHATSAPP_GATEWAY_URL', 'https://gateway.example');
    vi.stubEnv('WHATSAPP_GATEWAY_SECRET', secret);
    connection = {
      id: randomUUID(),
      companyId: company.id,
      provider: 'baileys',
      generation: 1,
      revision: 1,
      status: 'connected',
      accountJid: '923000000001@s.whatsapp.net',
      lastHeartbeatAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await repo.saveWhatsAppConnection(connection, 0);
    address = {
      connectionId: connection.id,
      generation: 1,
      provider: 'baileys',
      peer: '100000009@lid',
    };
    fetch = vi.fn(async () => new Response(JSON.stringify({ messageId: 'wa-1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
  });
  const chat = async () => {
    const c: Conversation = {
      ...createConversation(company.id, '', 'whatsapp', new Date().toISOString()),
      whatsappAddress: address,
      messages: [
        {
          id: 'reply-1',
          role: 'assistant',
          text: 'Here is our menu.',
          createdAt: new Date().toISOString(),
        },
      ],
    };
    await repo.saveConversation(c);
    return c;
  };
  const send = (c: Conversation) =>
    makeJob(company.id, 'whatsapp_send', {
      ...jobAddress(c),
      conversationId: c.id,
      messageId: 'reply-1',
      text: 'Here is our menu.',
      source: 'notice',
    });

  it('G5.2: ends a reply queued for a previous connection as not sent, for good', async () => {
    const c = await chat();
    const job = send(c);
    await repo.insertJob(job);
    await saveConnection(repo, { ...connection, generation: 2 });
    await processJob(repo, job.id);
    expect(fetch).not.toHaveBeenCalled();
    expect((await repo.getJob(job.id))!.status).toBe('done');
    const reply = (await repo.getConversation(company.id, c.id))!.messages[0]!;
    expect(reply.delivery).toBe('failed');
    expect(reply.deliveryError).toBe('Not sent: queued for a previous WhatsApp connection.');
    expect((await repo.listTraces(company.id)).some((t) => t.action === 'whatsapp.not_sent')).toBe(
      true,
    );
    // Nothing is left failing for "Retry failed work" to send again.
    expect(await repo.retryFailedJobs(company.id)).toBe(0);
  });

  it('G4.1: frees the connection for the next send before the bookkeeping', async () => {
    const c = await chat();
    const job = send(c);
    await repo.insertJob(job);
    const steps: string[] = [];
    const release = repo.releaseConversationLock.bind(repo);
    vi.spyOn(repo, 'releaseConversationLock').mockImplementation(async (companyId, id, owner) => {
      if (id === 'whatsapp-connection') steps.push('release');
      return release(companyId, id, owner);
    });
    const saveJob = repo.saveJob.bind(repo);
    vi.spyOn(repo, 'saveJob').mockImplementation(async (saved) => {
      if (saved.payload.externalId && saved.status === 'processing') steps.push('checkpoint');
      if (saved.status === 'done') steps.push('done');
      return saveJob(saved);
    });
    const record = repo.recordDelivery.bind(repo);
    let otherSend: boolean | undefined;
    vi.spyOn(repo, 'recordDelivery').mockImplementation(async (...args) => {
      steps.push('delivery');
      // Another reply of the business can take the connection meanwhile.
      otherSend = await repo.acquireConversationLock(
        company.id,
        'whatsapp-connection',
        'other-send',
        new Date(Date.now() + 60000).toISOString(),
      );
      return record(...args);
    });
    fetch.mockImplementation(async () => {
      steps.push('provider');
      return new Response(JSON.stringify({ messageId: 'wa-1' }), { status: 200 });
    });
    await processJob(repo, job.id);
    expect(steps).toEqual(['provider', 'checkpoint', 'release', 'delivery', 'done']);
    expect(otherSend).toBe(true);
    expect((await repo.getJob(job.id))!.status).toBe('done');
  });
});
