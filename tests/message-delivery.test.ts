import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MemoryRepository } from '../server/repository';
import { jobAddress, receiveGatewayEvent } from '../server/whatsapp/connections';
import { makeJob } from '../server/jobs';
import { processJob } from '../server/service';
import { createConversation, processTurn } from '../src/domain/engine';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import {
  gatewayEventSchema,
  type WhatsAppAddress,
  type WhatsAppConnection,
} from '../src/shared/whatsapp';
import { deliveryLabel } from '../src/components/Inbox';
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
});

describe('switching the bot off only pauses it', () => {
  it('keeps the conversation with the bot, so it answers again once switched on', () => {
    const paused = turn({ ...company, botEnabled: false }, 'hi');
    expect(paused.reply).toBe('');
    expect(paused.traces).toContain('human_mode_message_saved');
    expect(paused.conversation.mode).toBe('bot');
    const resumed = turn({ ...company, botEnabled: true }, 'menu', undefined, {
      ...paused.conversation,
    });
    expect(resumed.reply).toContain('Chicken Biryani');
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
