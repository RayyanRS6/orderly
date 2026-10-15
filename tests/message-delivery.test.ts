import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MemoryRepository } from '../server/repository';
import { jobAddress, receiveGatewayEvent } from '../server/whatsapp/connections';
import { makeJob } from '../server/jobs';
import { handleTurn, processJob } from '../server/service';
import { createConversation, processTurn } from '../src/domain/engine';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import {
  gatewayEventSchema,
  type WhatsAppAddress,
  type WhatsAppConnection,
} from '../src/shared/whatsapp';
import { deliveryLabel } from '../src/components/Inbox';
import { defaultBot } from '../src/shared/bot';
import type { BotAction, Company, Conversation, Message } from '../src/shared/types';

const company = seedCompanies[0]!;
const products = seedProducts.filter((p) => p.companyId === company.id);
const now = '2026-09-09T13:30:00.000Z';
const fresh = (): Conversation => createConversation(company.id, '923000000555', 'demo', now);
const turn = (
  target: Company,
  text: string,
  actions?: BotAction[],
  conversation: Conversation = fresh(),
) =>
  processTurn(
    target,
    products,
    conversation,
    { messageId: `message-${randomUUID()}`, text, now },
    actions,
    actions ? { text: 'Here is our menu.', askFor: 'items' } : undefined,
  );

describe('menu replies are never empty', () => {
  it('shows the whole menu when the AI searches for the word “menu” or “rates”', () => {
    for (const query of ['menu', 'rates', 'full menu', 'Prices', 'مینو']) {
      const { reply } = turn(company, 'menu', [{ type: 'menu', query }]);
      expect(reply).toContain('Chicken Biryani');
      expect(reply).toContain('Chicken Karahi');
      expect(reply).not.toMatch(/No matching|couldn’t find/);
    }
  });
  it('says an unknown dish is missing and still shows the whole menu', () => {
    const { reply } = turn(company, 'do you have pizza', [{ type: 'menu', query: 'pizza' }]);
    expect(reply).toContain('We couldn’t find “pizza” on the menu.');
    expect(reply).toContain('Chicken Biryani');
  });
  it('still narrows the menu to a dish that exists', () => {
    const { reply } = turn(company, 'karahi price?', [{ type: 'menu', query: 'karahi' }]);
    expect(reply).toContain('Chicken Karahi');
    expect(reply).not.toContain('Chicken Biryani');
  });
  it('explains an empty catalog instead of listing nothing', () => {
    const reply = processTurn(company, [], fresh(), { messageId: 'empty', text: 'menu', now }, [
      { type: 'menu' },
    ]).reply;
    expect(reply).toContain('Our menu is not available right now.');
  });
  it('narrows a dish mixed with generic words instead of calling it missing', () => {
    for (const query of ['biryani rates', 'karahi menu', 'all biryani', 'do you have biryani']) {
      const { reply } = turn(company, query, [{ type: 'menu', query }]);
      expect(reply).not.toContain('couldn’t find');
      expect(reply).toMatch(/Chicken (Biryani|Karahi)/);
      expect(reply.includes('Chicken Biryani') && reply.includes('Chicken Karahi')).toBe(false);
    }
  });
  it('quotes only plain words, cut safely, and never AI text about prices or orders', () => {
    const odd = turn(company, 'x', [{ type: 'menu', query: '*pizza*\n_deal_ 🍕🍕' }]).reply;
    expect(odd).toContain('We couldn’t find “pizza deal” on the menu.');
    const long = turn(company, 'x', [
      { type: 'menu', query: '🍕'.repeat(30) + ' zzzz'.repeat(20) },
    ]);
    expect(long.reply).not.toMatch(/�|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    const unsafe = turn(company, 'x', [{ type: 'menu', query: 'Rs 0 deal order confirmed' }]);
    expect(unsafe.reply).toContain('We couldn’t find that on the menu.');
    expect(unsafe.reply).not.toContain('confirmed');
  });
  it('does not let an everyday Urdu or Roman-Urdu word hide a dish', () => {
    for (const query of [
      'biryani price batao',
      'biryani kitne ki hai',
      'بریانی کی قیمت کیا ہے',
      'karahi rates btao',
      'biryani wala',
    ]) {
      const { reply } = turn(company, query, [{ type: 'menu', query }]);
      expect(reply, query).not.toContain('couldn’t find');
      expect(reply.includes('Chicken Biryani') && reply.includes('Chicken Karahi'), query).toBe(
        false,
      );
    }
  });
});

describe('a mislabelled AI follow-up never hands the chat to staff', () => {
  // The live bot's published settings at the time: handoff message "Love you.".
  const live: Company = {
    ...company,
    bot: {
      draft: defaultBot,
      revision: 20,
      history: [],
      published: {
        version: 3,
        config: { ...defaultBot, handoffMessage: 'Love you.' },
        publishedAt: now,
        publishedBy: 'test',
      },
    },
  };
  const answer = (
    text: string,
    response: { text: string; askFor: 'anything_else' | 'fulfillment'; groundingIds?: string[] },
    conversation: Conversation = fresh(),
  ) =>
    processTurn(
      live,
      products,
      conversation,
      { messageId: `m-${randomUUID()}`, text, now },
      [{ type: 'answer', text: '' }],
      response,
    );

  it('answers "hi" with an empty cart instead of handing off (the live 19:39 case)', () => {
    for (const text of ['hi', 'is anyone there?']) {
      const result = answer(text, {
        text: 'Hi! Anything else I can help you with today?',
        askFor: 'anything_else',
      });
      expect(result.reply, text).not.toBe('Love you.');
      expect(result.traces, text).not.toContain('handoff');
      expect(result.conversation.mode, text).toBe('bot');
    }
    expect(
      answer('is anyone there?', {
        text: 'Yes, I am here! What would you like?',
        askFor: 'anything_else',
      }).reply,
    ).toBe('Yes, I am here! What would you like?');
  });

  it('asks the right next question when the AI re-asks a collected detail', () => {
    const c = fresh();
    c.cart = {
      ...c.cart,
      items: [{ productId: products[0]!.id, quantity: 1, modifierIds: [], notes: '' }] as never,
      fulfillment: 'pickup',
    };
    const result = answer('thanks', { text: 'Pickup or delivery?', askFor: 'fulfillment' }, c);
    expect(result.conversation.mode).toBe('bot');
    expect(result.reply).not.toContain('Pickup or delivery?');
    expect(result.reply).not.toBe('Love you.');
    expect(result.traces).toContain('response_fallback');
  });

  it('still hands off an answer built on facts that do not exist', () => {
    const result = answer('do you have parking?', {
      text: 'Yes, free parking for 50 cars.',
      askFor: 'anything_else',
      groundingIds: ['made-up-fact'],
    });
    expect(result.traces).toContain('handoff');
    expect(result.conversation.mode).toBe('human');
  });
});

describe('switching the bot off pauses it without losing customers', () => {
  let repo: MemoryRepository;
  const whatsapp = (phone = '923000000777') =>
    createConversation(company.id, phone, 'whatsapp', now);
  const say = (text: string, c: Conversation, action?: BotAction) =>
    handleTurn(repo, company, c, {
      messageId: `m-${randomUUID()}`,
      text,
      now: new Date().toISOString(),
      ...(action && { action }),
    });
  const setBot = async (botEnabled: boolean) =>
    repo.saveCompany({ ...(await repo.getCompany(company.id))!, botEnabled });
  beforeEach(() => {
    vi.stubEnv('APP_MODE', 'demo');
    repo = new MemoryRepository();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('shows the chat to staff while off and gives it back to the bot once on', async () => {
    await setBot(false);
    const paused = await say('hi', whatsapp());
    expect(paused.reply).toBe('');
    expect(paused.conversation.mode).toBe('human');
    expect(paused.conversation.botPausedAt).toBeTruthy();
    const attention = await repo.staffAttention(company.id);
    expect(attention.items.some((i) => i.entityId === paused.conversation.id)).toBe(true);
    await setBot(true);
    const resumed = await say('menu', paused.conversation);
    expect(resumed.reply).toContain('Chicken Biryani');
    expect(resumed.conversation.mode).toBe('bot');
    expect(resumed.conversation.botPausedAt).toBeUndefined();
  });

  it('stays with staff when staff replied or the customer asked for a person', async () => {
    await setBot(false);
    const paused = await say('hi', whatsapp());
    const stored = (await repo.getConversation(company.id, paused.conversation.id))!;
    await repo.saveConversation(
      {
        ...stored,
        version: stored.version + 1,
        messages: [
          ...stored.messages,
          { id: 'staff-1', role: 'staff', text: 'Hello!', createdAt: new Date().toISOString() },
        ],
      },
      stored.version,
    );
    const asked = await say('voice note', whatsapp('923000000888'), { type: 'handoff' });
    expect(asked.conversation.botPausedAt).toBeUndefined();
    const typed = await say('I want to talk to staff please', whatsapp('923000000999'));
    expect(typed.conversation.botPausedAt).toBeUndefined();
    await setBot(true);
    for (const id of [paused.conversation.id, asked.conversation.id, typed.conversation.id]) {
      const c = (await repo.getConversation(company.id, id))!;
      const result = await say('menu', c);
      expect(result.reply).toBe('');
      expect(result.conversation.mode).toBe('human');
    }
  });

  it('an automatic order-status notice does not keep a paused chat from the bot', async () => {
    await setBot(false);
    const paused = await say('any update?', whatsapp());
    const stored = (await repo.getConversation(company.id, paused.conversation.id))!;
    const notice = {
      id: 'status-1',
      role: 'staff' as const,
      text: 'Order A1 is now accepted.',
      createdAt: new Date().toISOString(),
      notice: true,
    };
    await repo.saveConversation(
      { ...stored, version: stored.version + 1, messages: [...stored.messages, notice] },
      stored.version,
    );
    await setBot(true);
    const latest = (await repo.getConversation(company.id, paused.conversation.id))!;
    expect((await say('menu', latest)).reply).toContain('Chicken Biryani');
  });

  it('lets a customer cancel right after the bot takes a paused chat back', async () => {
    let c = whatsapp('923000000444');
    const step = (action: BotAction) => {
      const result = processTurn(company, products, c, {
        messageId: randomUUID(),
        text: action.type === 'confirm' ? 'confirm' : 'test',
        action,
        now: new Date().toISOString(),
      });
      c = result.conversation;
      return result;
    };
    step({ type: 'add_item', productId: products[0]!.id, quantity: 1 });
    step({ type: 'set_details', customerName: 'Pause Test', fulfillment: 'pickup' });
    step({ type: 'review' });
    const placed = step({ type: 'confirm' });
    c.version = 1;
    await repo.commitTurn(company.id, c, 0, placed.order);
    await setBot(false);
    await say('hello?', c);
    await setBot(true);
    const paused = (await repo.getConversation(company.id, c.id))!;
    expect(paused.botPausedAt).toBeTruthy();
    const result = await say('cancel', paused);
    expect(result.order?.status).toBe('cancelled');
    expect((await repo.getOrder(company.id, placed.order!.id))?.status).toBe('cancelled');
  });
});

describe('WhatsApp delivery', () => {
  const secret = 'gateway-test-secret-with-more-than-32-characters';
  let repo: MemoryRepository;
  let connection: WhatsAppConnection;
  let address: WhatsAppAddress;
  const future = () => new Date(Date.now() + 60000).toISOString();
  const event = (overrides: Record<string, unknown> = {}) =>
    gatewayEventSchema.parse({
      eventId: randomUUID(),
      connectionId: connection.id,
      generation: 1,
      type: 'message',
      peer: address.peer,
      messageId: 'wamid-one',
      text: 'menu',
      fromMe: false,
      timestamp: new Date().toISOString(),
      ...overrides,
    });
  const savedConversation = async (messages: Message[] = []) => {
    const c = {
      ...createConversation(company.id, '', 'whatsapp', new Date().toISOString()),
      whatsappAddress: address,
      messages,
    };
    await repo.saveConversation(c);
    return c;
  };
  beforeEach(async () => {
    vi.stubEnv('APP_MODE', 'demo');
    vi.stubEnv('ORDERLY_RUNTIME', '');
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('WHATSAPP_GATEWAY_ENABLED', 'true');
    vi.stubEnv('WHATSAPP_GATEWAY_URL', 'https://gateway.example');
    vi.stubEnv('WHATSAPP_GATEWAY_SECRET', secret);
    repo = new MemoryRepository();
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
      peer: '100000001@lid',
    };
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('answers a customer while another reply holds the WhatsApp connection', async () => {
    await repo.acquireConversationLock(company.id, 'whatsapp-connection', 'other-send', future());
    await receiveGatewayEvent(repo, event());
    const [job] = await repo.listCompanyJobs(company.id);
    await processJob(repo, job.id);
    expect((await repo.getJob(job.id))?.status).toBe('done');
    const sends = (await repo.listCompanyJobs(company.id)).filter(
      (j) => j.kind === 'whatsapp_send',
    );
    expect(sends).toHaveLength(1);
  });

  it('waits for a busy connection instead of deferring a reply to the next minute', async () => {
    vi.stubEnv('APP_MODE', 'live');
    const c = await savedConversation();
    const job = makeJob(company.id, 'whatsapp_send', {
      ...jobAddress(c),
      conversationId: c.id,
      text: 'hello',
      source: 'notice',
    });
    await repo.insertJob(job);
    await repo.acquireConversationLock(company.id, 'whatsapp-connection', 'other-send', future());
    setTimeout(
      () => void repo.releaseConversationLock(company.id, 'whatsapp-connection', 'other-send'),
      400,
    );
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ messageId: 'wa-1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await processJob(repo, job.id);
    expect(fetch).toHaveBeenCalledTimes(1);
    const saved = await repo.getJob(job.id);
    expect(saved?.status).toBe('done');
    expect(saved?.attempts).toBe(1);
  });

  it('sends replies to one customer in the order they were written', async () => {
    vi.stubEnv('APP_MODE', 'live');
    const c = await savedConversation();
    const reply = (text: string) =>
      makeJob(company.id, 'whatsapp_send', {
        ...jobAddress(c),
        conversationId: c.id,
        text,
        source: 'notice',
      });
    const first = { ...reply('first'), createdAt: new Date(Date.now() - 2000).toISOString() };
    const second = reply('second');
    await repo.insertJob(first);
    await repo.insertJob(second);
    const sent: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init: RequestInit) => {
        sent.push(JSON.parse(String(init.body)).text);
        return new Response(JSON.stringify({ messageId: `wa-${sent.length}` }), { status: 200 });
      }),
    );
    // The later reply is picked up first and must wait for the earlier one.
    const later = processJob(repo, second.id);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(sent).toEqual([]);
    await processJob(repo, first.id);
    await later;
    expect(sent).toEqual(['first', 'second']);
    expect((await repo.getJob(second.id))?.status).toBe('done');
  });

  it('does not let a stuck earlier send hold back replies, nor use up their retries', async () => {
    vi.stubEnv('APP_MODE', 'live');
    const c = await savedConversation();
    const reply = (text: string, ago: number) => ({
      ...makeJob(company.id, 'whatsapp_send', {
        ...jobAddress(c),
        conversationId: c.id,
        text,
        source: 'notice',
      }),
      createdAt: new Date(Date.now() - ago).toISOString(),
    });
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ messageId: 'wa-ok' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetch);
    // A worker died mid-send 200 s ago: its job still says 'processing' with a long lease.
    const abandoned = reply('abandoned', 300000);
    await repo.insertJob(abandoned);
    await repo.claimJob(
      abandoned.id,
      new Date().toISOString(),
      new Date(Date.now() + 480000 - 200000).toISOString(),
    );
    const next = reply('next', 1000);
    await repo.insertJob(next);
    await processJob(repo, next.id);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await repo.getJob(next.id))?.status).toBe('done');
    // An earlier reply that is still queued is waited for, without spending retries.
    const queued = reply('queued', 2000);
    await repo.insertJob({ ...queued, nextRunAt: new Date(Date.now() + 600000).toISOString() });
    const after = reply('after', 0);
    await repo.insertJob(after);
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    try {
      const waiting = processJob(repo, after.id);
      await vi.advanceTimersByTimeAsync(31000);
      await waiting;
    } finally {
      vi.useRealTimers();
    }
    const saved = await repo.getJob(after.id);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(saved?.status).toBe('pending');
    expect(saved?.attempts).toBe(0);
    expect(saved?.error).toContain('earlier reply');
  });

  it('keeps a chat with the bot when a replayed staff message predates "Resume bot"', async () => {
    const c = {
      ...(await savedConversation()),
      botResumedAt: new Date().toISOString(),
      version: 1,
    };
    await repo.saveConversation(c, 0);
    const old = new Date(Date.now() - 5 * 60000).toISOString();
    await receiveGatewayEvent(
      repo,
      event({ fromMe: true, text: 'staff reply from the phone', timestamp: old }),
    );
    expect((await repo.getConversation(company.id, c.id))?.mode).toBe('bot');
    const [echo] = await repo.listCompanyJobs(company.id);
    await processJob(repo, echo!.id);
    const after = (await repo.getConversation(company.id, c.id))!;
    expect(after.mode).toBe('bot');
    expect(after.messages.at(-1)?.role).toBe('staff');
    // A newer staff message still takes the chat over.
    await receiveGatewayEvent(repo, event({ fromMe: true, messageId: 'new', text: 'hi again' }));
    expect((await repo.getConversation(company.id, c.id))?.mode).toBe('human');
  });

  it('marks a reply that never left as not delivered, with the reason', async () => {
    const message = (id: string): Message => ({
      id,
      role: 'assistant',
      text: 'hi',
      createdAt: now,
    });
    // Staff took over before the bot's reply went out.
    const taken = { ...(await savedConversation([message('dropped')])) };
    await repo.saveConversation({ ...taken, mode: 'human', version: 1 }, 0);
    const dropped = makeJob(company.id, 'whatsapp_send', {
      ...jobAddress(taken),
      conversationId: taken.id,
      messageId: 'dropped',
      text: 'hi',
      source: 'bot',
    });
    await repo.insertJob(dropped);
    await processJob(repo, dropped.id);
    const afterDrop = (await repo.getConversation(company.id, taken.id))!.messages[0]!;
    expect(afterDrop.delivery).toBe('failed');
    expect(afterDrop.deliveryError).toContain('staff took over');
    expect(afterDrop.externalId).toBeUndefined();
    // A chat paused because the bot was off is not described as a staff takeover.
    const paused = {
      ...createConversation(company.id, '', 'whatsapp', new Date().toISOString()),
      whatsappAddress: { ...address, peer: '100000008@lid' },
      mode: 'human' as const,
      botPausedAt: new Date().toISOString(),
      messages: [message('paused-reply')],
    };
    await repo.saveConversation(paused);
    const pausedJob = makeJob(company.id, 'whatsapp_send', {
      ...jobAddress(paused),
      conversationId: paused.id,
      messageId: 'paused-reply',
      text: 'hi',
      source: 'bot',
    });
    await repo.insertJob(pausedJob);
    await processJob(repo, pausedJob.id);
    expect(
      (await repo.getConversation(company.id, paused.id))!.messages[0]!.deliveryError,
    ).toContain('the bot was switched off');
    // A send that fails for good, here outside WhatsApp's 24-hour reply window.
    const old = {
      ...createConversation(company.id, '', 'whatsapp', '2020-01-01T00:00:00.000Z'),
      whatsappAddress: { ...address, peer: '100000009@lid' },
      messages: [message('late')],
    };
    await repo.saveConversation(old);
    const failing = makeJob(company.id, 'whatsapp_send', {
      ...jobAddress(old),
      conversationId: old.id,
      messageId: 'late',
      text: 'hi',
      source: 'notice',
    });
    await repo.insertJob(failing);
    await processJob(repo, failing.id);
    expect((await repo.getJob(failing.id))?.status).toBe('failed');
    const late = (await repo.getConversation(company.id, old.id))!.messages[0]!;
    expect(late.delivery).toBe('failed');
    expect(late.deliveryError).toContain('24 hours');
  });

  it('shows delivered and read ticks, whichever order they arrive in', async () => {
    const reply: Message = { id: 'reply-1', role: 'assistant', text: 'hi', createdAt: now };
    const c = await savedConversation([reply]);
    const receipt = (messageId: string, value: 'delivered' | 'read') =>
      receiveGatewayEvent(
        repo,
        gatewayEventSchema.parse({
          eventId: randomUUID(),
          connectionId: connection.id,
          generation: 1,
          type: 'receipt',
          messageId,
          receipt: value,
          timestamp: new Date().toISOString(),
        }),
      );
    const delivery = async () =>
      (await repo.getConversation(company.id, c.id))?.messages.find((m) => m.id === 'reply-1')
        ?.delivery;
    // A tick can reach the backend before the send job saves its receipt.
    await receipt('wa-1', 'delivered');
    await repo.recordDelivery(company.id, 'wa-1', 'accepted', c.id, 'reply-1');
    expect(await delivery()).toBe('delivered');
    await receipt('wa-1', 'read');
    await receipt('wa-1', 'delivered');
    expect(await delivery()).toBe('read');
    await expect(
      receiveGatewayEvent(repo, event({ type: 'receipt', peer: undefined, text: undefined })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('records the customer number once WhatsApp shares it', async () => {
    await receiveGatewayEvent(repo, event({ text: 'hi' }));
    await receiveGatewayEvent(repo, event({ messageId: 'two', phoneNumber: '+923001234567' }));
    for (let i = 0; i < 2; i++) {
      const [next] = (await repo.listDueJobs(10)).filter((j) => j.kind === 'incoming');
      await processJob(repo, next!.id);
    }
    const conversation = await repo.findWhatsAppConversation(company.id, address);
    expect(conversation?.customerPhone).toBe('+923001234567');
    expect(conversation?.messages.filter((m) => m.role === 'customer')).toHaveLength(2);
  });

  it('labels replies the way WhatsApp does', () => {
    const c = { ...createConversation(company.id, '', 'whatsapp', now) };
    const at = Date.parse(now);
    const m = (delivery?: Message['delivery']): Message => ({
      id: 'm',
      role: 'assistant',
      text: 'hi',
      createdAt: now,
      ...(delivery && { delivery }),
    });
    expect(deliveryLabel(c, m(), at + 5000)).toBe('Sending…');
    expect(deliveryLabel(c, m(), at + 300000)).toBeUndefined();
    expect(deliveryLabel(c, m('accepted'), at)).toBe('Sent ✓');
    expect(deliveryLabel(c, m('delivered'), at)).toBe('Delivered ✓✓');
    expect(deliveryLabel(c, m('read'), at)).toBe('Read ✓✓');
    expect(deliveryLabel(c, m('failed'), at)).toBe('Not delivered');
    expect(deliveryLabel(fresh(), m(), at)).toBeUndefined();
  });
});
