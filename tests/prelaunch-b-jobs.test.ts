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

describe('G7.1: a customer whose order is still waiting is told so once', () => {
  const step = (c: Conversation, action: BotAction) =>
    processTurn(company, products, c, {
      messageId: randomUUID(),
      text: action.type === 'confirm' ? 'confirm' : 'step',
      action,
      now: new Date().toISOString(),
    });
  async function waitingOrder(change: Partial<Conversation> = {}) {
    let c: Conversation = {
      ...createConversation(
        company.id,
        `92300660${randomUUID().slice(0, 4).replace(/\D/g, '1')}`,
        'whatsapp',
        new Date().toISOString(),
      ),
      version: 0,
    };
    for (const action of [
      { type: 'add_item', productId: products[0]!.id, quantity: 1 },
      { type: 'set_details', customerName: 'Ali Raza', fulfillment: 'pickup' },
      { type: 'review' },
    ] as BotAction[])
      c = step(c, action).conversation;
    const placed = step(c, { type: 'confirm' });
    const saved = { ...placed.conversation, ...change, version: 1 };
    await repo.commitTurn(company.id, saved, 0, placed.order);
    return { conversation: saved, order: placed.order! };
  }
  const followup = (order: Order) =>
    makeJob(company.id, 'order_followup', {
      orderId: order.id,
      conversationId: order.conversationId,
    });
  const run = async (job: Job) => {
    await repo.insertJob(job);
    await processJob(repo, job.id);
    expect((await repo.getJob(job.id))!.status).toBe('done');
  };
  const sends = async () =>
    (await repo.listCompanyJobs(company.id)).filter((j) => j.kind === 'whatsapp_send');
  const reminders = async (c: Conversation) =>
    (await repo.getConversation(company.id, c.id))!.messages.filter((m) =>
      m.id.startsWith('order-followup:'),
    );

  it('sends one reminder through the normal send path, never by itself', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { conversation, order } = await waitingOrder();
    const before = (await sends()).length;
    await run(followup(order));
    expect(fetch).not.toHaveBeenCalled();
    const [reminder] = await reminders(conversation);
    expect(reminder).toMatchObject({
      id: `order-followup:${order.id}`,
      role: 'assistant',
      text: `Your order ${order.reference} hasn't been confirmed by the restaurant yet. We've flagged it to the restaurant. Reply “cancel” if you want to cancel.`,
      // Automatic: it never makes a chat staff answered look unanswered.
      notice: true,
    });
    const queued = (await sends()).slice(0, (await sends()).length - before);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.payload).toMatchObject({
      conversationId: conversation.id,
      messageId: reminder!.id,
      text: reminder!.text,
      orderId: order.id,
      status: 'pending',
      source: 'notice',
    });
    expect(queued[0]!.payload.reference).toBeUndefined();
    expect((await repo.listTraces(company.id)).some((t) => t.action === 'order_followup')).toBe(
      true,
    );
    // Running it again changes nothing.
    await run(followup(order));
    expect(await reminders(conversation)).toHaveLength(1);
    expect((await sends()).length).toBe(before + 1);
  });

  it('never treats a kind of job it does not know as a WhatsApp message', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { conversation } = await waitingOrder();
    const unknown = {
      ...makeJob(company.id, 'order_followup', { conversationId: conversation.id, text: 'x' }),
      kind: 'from_a_newer_version' as Job['kind'],
    };
    await repo.insertJob(unknown);
    await processJob(repo, unknown.id);
    expect(fetch).not.toHaveBeenCalled();
    expect(await sends()).toHaveLength(0);
    expect((await repo.getJob(unknown.id))!).toMatchObject({
      status: 'failed',
      error: 'This version of Orderly cannot run this kind of job.',
    });
  });

  it('says nothing for an order already accepted, a test order or a chat past 24 hours', async () => {
    const accepted = await waitingOrder();
    await repo.saveOrder({ ...accepted.order, status: 'accepted' });
    await run(followup(accepted.order));
    expect(await reminders(accepted.conversation)).toHaveLength(0);

    const test = await waitingOrder();
    await repo.saveOrder({ ...test.order, sandbox: true });
    await run(followup(test.order));
    expect(await reminders(test.conversation)).toHaveLength(0);

    const old = await waitingOrder({
      lastInboundAt: new Date(Date.now() - 25 * 3600000).toISOString(),
    });
    await run(followup(old.order));
    expect(await reminders(old.conversation)).toHaveLength(0);
  });

  it('says nothing once staff spoke to the customer about the order on the phone', async () => {
    const call = (outcome: NonNullable<Order['phoneConfirmation']>['outcome']) => ({
      outcome,
      addressVerified: false,
      note: '',
      at: new Date().toISOString(),
      actorId: 'staff-1',
    });
    for (const outcome of ['confirmed', 'declined'] as const) {
      const called = await waitingOrder();
      await repo.saveOrder({ ...called.order, phoneConfirmation: call(outcome) });
      await run(followup(called.order));
      expect(await reminders(called.conversation)).toHaveLength(0);
    }
    // Staff could not reach them: the customer still hears that the order is waiting.
    const unreachable = await waitingOrder();
    await repo.saveOrder({ ...unreachable.order, phoneConfirmation: call('unreachable') });
    await run(followup(unreachable.order));
    expect(await reminders(unreachable.conversation)).toHaveLength(1);
  });

  it('leaves out “cancel” when the bot would not handle it, and speaks the customer’s language', async () => {
    const staff = await waitingOrder({ mode: 'human' });
    await run(followup(staff.order));
    const [reminder] = await reminders(staff.conversation);
    expect(reminder!.text).toBe(
      `Your order ${staff.order.reference} hasn't been confirmed by the restaurant yet. We've flagged it to the restaurant.`,
    );
    const roman = await waitingOrder({ language: 'roman-ur' });
    await run(followup(roman.order));
    expect((await reminders(roman.conversation))[0]!.text).toBe(
      `Aap ke order ${roman.order.reference} ko abhi restaurant ne confirm nahi kiya. Humne restaurant ko iski ittela de di hai. Order cancel karna ho to “cancel” likhein.`,
    );
    const urdu = await waitingOrder({ language: 'ur' });
    await run(followup(urdu.order));
    expect((await reminders(urdu.conversation))[0]!.text).toBe(
      `آپ کے آرڈر ${urdu.order.reference} کی ابھی ریسٹورنٹ نے تصدیق نہیں کی۔ ہم نے ریسٹورنٹ کو اس کی اطلاع دے دی ہے۔ اگر آپ آرڈر منسوخ کرنا چاہتے ہیں تو “cancel” لکھیں۔`,
    );
    // Nothing in any language claims staff were reminded.
    for (const c of [staff, roman, urdu])
      expect((await reminders(c.conversation))[0]!.text).not.toMatch(/remind|yaad|یاد/i);
  });

  it('drops the queued reminder if staff accepted the order first', async () => {
    await repo.saveIntegration(
      company.id,
      { kind: 'whatsapp', configured: true, status: 'connected', config: { phoneNumberId: '1' } },
      encryptSecret('meta-token'),
    );
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { order } = await waitingOrder();
    await run(followup(order));
    const reminder = (await sends()).find(
      (j) => j.payload.messageId === `order-followup:${order.id}`,
    )!;
    await repo.saveOrder({ ...order, status: 'accepted' });
    await processJob(repo, reminder.id);
    expect(fetch).not.toHaveBeenCalled();
    expect((await repo.getJob(reminder.id))!.status).toBe('done');
  });
});

describe('F33: the Confirm button goes only with the review the cart awaits', () => {
  it('attaches it to the review message, and never to another message sent meanwhile', async () => {
    vi.stubEnv('META_GRAPH_VERSION', 'v21.0');
    await repo.saveIntegration(
      company.id,
      { kind: 'whatsapp', configured: true, status: 'connected', config: { phoneNumberId: '1' } },
      encryptSecret('meta-token'),
    );
    const bodies: { type: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ messages: [{ id: `wamid-${bodies.length}` }] }), {
          status: 200,
        });
      }),
    );
    let c: Conversation = {
      ...createConversation(company.id, '923005500077', 'whatsapp', new Date().toISOString()),
      version: 0,
    };
    let reply = '';
    for (const action of [
      { type: 'add_item', productId: products[0]!.id, quantity: 1 },
      { type: 'set_details', customerName: 'Ali Raza', fulfillment: 'pickup' },
      { type: 'review' },
    ] as BotAction[]) {
      const turn = processTurn(company, products, c, {
        messageId: randomUUID(),
        text: 'step',
        action,
        now: new Date().toISOString(),
      });
      c = turn.conversation;
      reply = turn.reply;
    }
    expect(c.cart.status).toBe('awaiting_confirmation');
    await repo.commitTurn(company.id, { ...c, version: 1 }, 0);
    const send = (messageId: string, text: string) =>
      makeJob(company.id, 'whatsapp_send', {
        ...jobAddress(c),
        conversationId: c.id,
        messageId,
        text,
        cartRevision: c.cart.revision,
        source: 'bot',
      });
    // Another message of the same cart revision (a notice, a staff note) is plain text.
    const other = send('another-message', 'We are open until 11 pm.');
    await repo.insertJob(other);
    await processJob(repo, other.id);
    const review = send(c.cart.reviewMessageId!, reply);
    await repo.insertJob(review);
    await processJob(repo, review.id);
    expect(bodies.map((body) => body.type)).toEqual(['text', 'interactive']);
  });
});
