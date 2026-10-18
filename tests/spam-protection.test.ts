import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { createApp } from '../server/app';
import { MemoryRepository } from '../server/repository';
import { encryptSecret } from '../server/security';
import { droppedReplyReason, handleTurn, processJob } from '../server/service';
import { makeJob } from '../server/jobs';
import { modelFingerprint } from '../server/integrations/model-catalog';
import { receiveGatewayEvent } from '../server/whatsapp/connections';
import {
  createConversation,
  limitNotice,
  limitPaused,
  resumesAfterLimit,
} from '../src/domain/engine';
import { disclosureLine } from '../src/domain/disclosure';
import { defaultBot } from '../src/shared/bot';
import { AI_LIMIT_DEFAULTS, effectiveAiLimits } from '../src/shared/models';
import { seedCompanies } from '../src/shared/seed';
import { customerKeys, gatewayEventSchema, type WhatsAppConnection } from '../src/shared/whatsapp';
import type { Company, Conversation, ModelInterpretation } from '../src/shared/types';

const { generate } = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: generate,
  Output: { object: vi.fn() },
}));

const company = seedCompanies[0]!;
const key = 'fictional-anthropic-key';
const menu: ModelInterpretation = {
  actions: [{ type: 'menu' }],
  response: { text: 'Here is our menu.', askFor: 'items' },
};
const NOTICE = 'Thanks for your message! Our team will reply here soon.';
let repo: MemoryRepository;
let configured: Company;

beforeEach(async () => {
  generate.mockReset();
  generate.mockResolvedValue({ output: menu, usage: { inputTokens: 1200, outputTokens: 80 } });
  repo = new MemoryRepository();
  vi.stubEnv('APP_MODE', 'demo');
  vi.stubEnv('ORDERLY_RUNTIME', '');
  vi.stubEnv('VERCEL', '');
  vi.stubEnv('APP_URL', 'http://127.0.0.1:5173');
  vi.stubEnv('MODEL_PRICING_JSON', '');
  vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  await repo.saveIntegration(
    company.id,
    { kind: 'anthropic', configured: true, status: 'connected', config: {} },
    encryptSecret(key),
  );
  const base: Company = {
    ...company,
    botEnabled: true,
    ai: { provider: 'anthropic', model: 'claude-haiku-5-5', monthlyBudgetUsd: 10 },
    privacy: { aiDataApproved: true, retentionDays: 0 },
    bot: { draft: { ...defaultBot, language: 'en' }, revision: 1, history: [] },
  };
  configured = {
    ...base,
    modelVerification: {
      fingerprint: modelFingerprint(base, key),
      checkedAt: new Date().toISOString(),
    },
  };
  await repo.saveCompany(configured);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function settings(change: Partial<Company>) {
  configured = { ...configured, ...change };
  await repo.saveCompany(configured);
}
let phoneCounter = 0;
const newCustomer = () =>
  createConversation(
    company.id,
    `9230011${String(++phoneCounter).padStart(5, '0')}`,
    'whatsapp',
    '1970-01-01T00:00:00.000Z',
  );
async function message(
  conversation: Conversation,
  text = 'what do you have?',
  action?: Parameters<typeof handleTurn>[3]['action'],
) {
  const current = (await repo.getConversation(company.id, conversation.id)) ?? conversation;
  const result = await handleTurn(repo, configured, current, {
    messageId: randomUUID(),
    text,
    action,
    now: new Date().toISOString(),
  });
  return { result, saved: (await repo.getConversation(company.id, conversation.id))! };
}
const sends = async () =>
  (await repo.listCompanyJobs(company.id)).filter((job) => job.kind === 'whatsapp_send');
const paidReply = (minutesAgo = 0, sandbox = false) =>
  repo.addUsage({
    id: randomUUID(),
    companyId: company.id,
    provider: 'anthropic',
    model: 'claude-haiku-5-5',
    inputTokens: 1000,
    outputTokens: 50,
    costUsd: 0.0002,
    createdAt: new Date(Date.now() - minutesAgo * 60000).toISOString(),
    conversationId: `someone-${randomUUID()}`,
    sandbox,
  });
const hourly = (count: number) => Promise.all(Array.from({ length: count }, () => paidReply()));

describe('per-customer AI limit', () => {
  beforeEach(() => settings({ aiLimits: { repliesPerHour: 300, repliesPerCustomerPerHour: 5 } }));

  it('pauses one customer after their replies, tells them once, then stays quiet', async () => {
    const customer = newCustomer();
    for (let i = 0; i < 5; i++) expect((await message(customer)).saved.mode).toBe('bot');
    expect(generate).toHaveBeenCalledTimes(5);
    const sentBefore = (await sends()).length;

    const paused = await message(customer);
    expect(paused.result.reply).toBe(NOTICE);
    expect(paused.saved.mode).toBe('human');
    expect(paused.saved.limitPause).toMatchObject({ reason: 'customer', limit: 5 });
    const until = Date.parse(paused.saved.limitPause!.until);
    expect(until - Date.parse(paused.saved.limitPause!.at)).toBe(60 * 60 * 1000);
    expect(paused.result.explanation).toMatchObject({ notice: 'customer_limit', outcome: 'staff' });
    expect(await sends()).toHaveLength(sentBefore + 1);
    expect(await sends()).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({ source: 'notice', text: NOTICE }),
      }),
    );

    const quiet = await message(customer, 'hello?? anyone');
    expect(quiet.result.reply).toBe('');
    expect(quiet.saved.messages.at(-1)).toMatchObject({ role: 'customer', text: 'hello?? anyone' });
    expect(await sends()).toHaveLength(sentBefore + 1);
    expect(generate).toHaveBeenCalledTimes(5);
  });

  it('never limits other customers', async () => {
    const first = newCustomer();
    for (let i = 0; i < 6; i++) await message(first);
    expect((await repo.getConversation(company.id, first.id))!.mode).toBe('human');
    expect((await message(newCustomer())).saved.mode).toBe('bot');
  });

  it('gives the chat back after an hour with a full allowance', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-16T10:00:00.000Z'));
    const customer = newCustomer();
    for (let i = 0; i < 6; i++) await message(customer);
    expect((await repo.getConversation(company.id, customer.id))!.limitPause).toBeDefined();

    vi.setSystemTime(new Date('2026-10-16T11:00:30.000Z'));
    const back = await message(customer);
    expect(back.saved.mode).toBe('bot');
    expect(back.saved.limitPause).toBeUndefined();
    expect(back.saved.limitResumedAt).toBe('2026-10-16T11:00:30.000Z');
    expect(back.result.reply).toContain('Here is our menu.');
    for (let i = 0; i < 4; i++) expect((await message(customer)).saved.mode).toBe('bot');
    // Five replies since the return use the fresh allowance. The first notice was over an
    // hour ago, so reaching the limit again sends a new one.
    const again = await message(customer);
    expect(again.saved.mode).toBe('human');
    expect(again.result.reply).toBe(NOTICE);
  });

  it('gives the chat back at once when the owner raises the limit', async () => {
    const customer = newCustomer();
    for (let i = 0; i < 6; i++) await message(customer);
    await settings({ aiLimits: { repliesPerHour: 300, repliesPerCustomerPerHour: 50 } });
    const back = await message(customer);
    expect(back.saved.mode).toBe('bot');
    expect(back.result.reply).toContain('Here is our menu.');
  });

  it('lets a button through during a pause, then pauses again without a second notice', async () => {
    const customer = newCustomer();
    for (let i = 0; i < 6; i++) await message(customer);
    const calls = generate.mock.calls.length;
    const tapped = await message(customer, 'Menu', { type: 'menu' });
    expect(tapped.saved.mode).toBe('bot');
    expect(tapped.result.reply).toContain(company.name);
    expect(generate).toHaveBeenCalledTimes(calls);
    const typed = await message(customer, 'two burgers');
    expect(typed.saved.mode).toBe('human');
    expect(typed.result.reply).toBe('');
  });

  it('keeps the original pause time when a button tap interrupts it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-16T10:00:00.000Z'));
    const customer = newCustomer();
    for (let i = 0; i < 6; i++) await message(customer);
    vi.setSystemTime(new Date('2026-10-16T10:30:00.000Z'));
    await message(customer, 'Menu', { type: 'menu' });
    const repaused = await message(customer, 'two burgers');
    expect(repaused.saved.limitPause).toMatchObject({
      reason: 'customer',
      until: '2026-10-16T11:00:00.000Z',
    });
    vi.setSystemTime(new Date('2026-10-16T11:00:30.000Z'));
    expect((await message(customer)).saved.mode).toBe('bot');
  });

  it('hands the chat to staff for good when the message that hits the limit asks for a person', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-16T10:00:00.000Z'));
    const customer = newCustomer();
    for (let i = 0; i < 5; i++) await message(customer);
    const calls = generate.mock.calls.length;
    const asked = await message(customer, 'I want to talk to a human please');
    expect(asked.saved.mode).toBe('human');
    expect(asked.saved.limitPause).toBeUndefined();
    expect(asked.result.reply).not.toBe(NOTICE);
    vi.setSystemTime(new Date('2026-10-16T12:00:00.000Z'));
    const later = await message(customer);
    expect(later.saved.mode).toBe('human');
    expect(generate).toHaveBeenCalledTimes(calls);
  });

  it.each([
    ['a staff reply', 'reply'],
    ['staff taking over', 'mode'],
  ] as const)(
    'keeps the chat with staff after %s, even once the hour is over',
    async (_case, how) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-16T10:00:00.000Z'));
      const customer = newCustomer();
      for (let i = 0; i < 6; i++) await message(customer);
      const app = createApp(repo);
      const response = await app.request(
        `http://127.0.0.1:4000/api/conversations/${customer.id}/${how}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-company-id': company.id,
            Origin: 'http://127.0.0.1:5173',
          },
          body: JSON.stringify(how === 'reply' ? { text: 'Hi, I can help.' } : { mode: 'human' }),
        },
      );
      expect(response.status).toBe(200);
      expect((await repo.getConversation(company.id, customer.id))!.limitPause).toBeUndefined();
      vi.setSystemTime(new Date('2026-10-16T12:00:00.000Z'));
      const later = await message(customer);
      expect(later.saved.mode).toBe('human');
      expect(later.result.reply).toBe('');
    },
  );

  it('turns a pause into a real handoff when the customer asks for a person', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-16T10:00:00.000Z'));
    const customer = newCustomer();
    for (let i = 0; i < 6; i++) await message(customer);
    const asked = await message(customer, 'I want to talk to a human');
    expect(asked.saved.limitPause).toBeUndefined();
    vi.setSystemTime(new Date('2026-10-16T12:00:00.000Z'));
    expect((await message(customer)).saved.mode).toBe('human');
  });

  it('does not limit Test your bot chats', async () => {
    let chat = createConversation(company.id, 'demo-limits', 'demo', new Date().toISOString());
    for (let i = 0; i < 8; i++) {
      const result = await handleTurn(repo, configured, chat, {
        messageId: randomUUID(),
        text: 'menu please',
        now: new Date().toISOString(),
      });
      chat = result.conversation;
      expect(chat.mode).toBe('bot');
    }
    expect(generate).toHaveBeenCalledTimes(8);
  });
});

describe('hourly and monthly AI limits', () => {
  it('pauses every customer once the restaurant’s replies for the hour are used', async () => {
    await settings({ aiLimits: { repliesPerHour: 20, repliesPerCustomerPerHour: 30 } });
    await hourly(20);
    const customer = newCustomer();
    const paused = await message(customer);
    expect(generate).not.toHaveBeenCalled();
    // The first reply of the chat starts with the automated-assistant notice.
    expect(paused.result.reply).toBe(`${disclosureLine(company.name, 'en')}\n\n${NOTICE}`);
    expect(paused.saved.limitPause).toMatchObject({ reason: 'hourly', limit: 20 });
    const until = new Date(paused.saved.limitPause!.until);
    expect(until.getUTCMinutes()).toBe(0);
    expect(until.getTime() - Date.now()).toBeLessThanOrEqual(3600000);
    expect(paused.result.explanation?.notice).toBe('hourly_limit');
    expect((await repo.staffAttention(company.id)).items).toContainEqual(
      expect.objectContaining({ kind: 'limit', scope: 'hourly' }),
    );
    expect(await repo.hasOverdueAttention(company.id, 10)).toBe(true);

    await settings({ aiLimits: { repliesPerHour: 40, repliesPerCustomerPerHour: 30 } });
    expect(
      (await repo.staffAttention(company.id)).items.some((item) => item.kind === 'limit'),
    ).toBe(false);
    const back = await message(customer);
    expect(back.saved.mode).toBe('bot');
    expect(back.result.reply).toContain('Here is our menu.');
  });

  it('counts live calls still running, so a burst from many numbers cannot all pass', async () => {
    await settings({ aiLimits: { repliesPerHour: 20, repliesPerCustomerPerHour: 30 } });
    await hourly(19);
    const expires = new Date(Date.now() + 60_000).toISOString();
    expect(await repo.reserveAiCall(company.id, 'a', 0.001, expires, 'chat-a')).toEqual({
      ok: true,
    });
    expect(await repo.reserveAiCall(company.id, 'b', 0.001, expires, 'chat-b')).toMatchObject({
      ok: false,
      limit: 'hourly',
    });
    // Test chats and model checks are neither limited nor counted.
    expect(await repo.reserveAiCall(company.id, 'c', 0.001, expires)).toEqual({ ok: true });
    expect((await repo.aiLimitStatus(company.id)).repliesThisHour).toBe(20);
  });

  it('counts only live replies that cost something, in this clock hour', async () => {
    await settings({ aiLimits: { repliesPerHour: 20, repliesPerCustomerPerHour: 30 } });
    await hourly(19);
    await paidReply(0, true);
    await paidReply(61);
    expect((await repo.aiLimitStatus(company.id)).repliesThisHour).toBe(19);
    expect((await message(newCustomer())).saved.mode).toBe('bot');
  });

  it('pauses on the monthly budget and returns when it is raised', async () => {
    await settings({ ai: { ...configured.ai, monthlyBudgetUsd: 0 } });
    const customer = newCustomer();
    const paused = await message(customer);
    expect(paused.saved.limitPause).toMatchObject({ reason: 'monthly', limit: 0 });
    expect(paused.result.explanation?.notice).toBe('ai_budget');
    const nextMonth = new Date(paused.saved.limitPause!.until);
    expect(nextMonth.getUTCDate()).toBe(1);
    expect(nextMonth.getUTCHours()).toBe(0);
    await settings({ ai: { ...configured.ai, monthlyBudgetUsd: 10 } });
    expect((await message(customer)).saved.mode).toBe('bot');
  });

  it('tells a customer with a placed order that it is not affected, in their language', async () => {
    const config = { ...defaultBot, language: 'roman-ur' as const };
    await settings({ ai: { ...configured.ai, monthlyBudgetUsd: 0 } });
    // Bot settings are saved on their own, as the dashboard's Publish does.
    const revision = (await repo.getCompany(company.id))!.bot?.revision ?? 0;
    await repo.saveBot(
      company.id,
      {
        draft: config,
        revision: revision + 1,
        history: [],
        published: { version: 1, config, publishedAt: new Date().toISOString(), publishedBy: 't' },
      },
      revision,
    );
    const customer = { ...newCustomer(), cart: { ...newCustomer().cart, orderId: 'order-1' } };
    await repo.saveConversation({ ...customer, version: 1 }, 0);
    const paused = await message({ ...customer, version: 1 });
    expect(paused.result.reply).toBe(
      `${disclosureLine(company.name, 'roman-ur')}\n\nAap ke message ka shukriya! Hamari team jald yahin jawab degi. Aap ke order par koi asar nahi para.`,
    );
  });
});

describe('queued replies', () => {
  const base = () => ({
    ...createConversation(company.id, '923001234500', 'whatsapp', new Date().toISOString()),
    version: 2,
  });
  const job = (source: string, createdAt: string) => ({
    ...makeJob(company.id, 'whatsapp_send', { conversationId: 'x', text: 'hi', source }),
    createdAt,
  });

  it('still sends a bot reply written before a limit paused the chat', () => {
    const conversation: Conversation = {
      ...base(),
      mode: 'human',
      limitPause: {
        reason: 'hourly',
        at: '2026-10-16T10:00:05.000Z',
        until: '2026-10-16T11:00:00.000Z',
        limit: 300,
      },
    };
    expect(
      droppedReplyReason(job('bot', '2026-10-16T10:00:04.000Z'), conversation, configured),
    ).toBeUndefined();
    expect(
      droppedReplyReason(job('bot', '2026-10-16T10:00:06.000Z'), conversation, configured),
    ).toBe('Not sent: staff took over this chat before the reply went out.');
  });

  it('drops every automatic message to a blocked number, but not staff replies', () => {
    const conversation: Conversation = {
      ...base(),
      blocked: { at: '2026-10-16T10:00:00.000Z', blockId: 'b1' },
    };
    const now = new Date().toISOString();
    expect(droppedReplyReason(job('bot', now), conversation, configured)).toBe(
      'Not sent: this number was blocked.',
    );
    expect(droppedReplyReason(job('notice', now), conversation, configured)).toBe(
      'Not sent: this number was blocked.',
    );
    const staff = makeJob(company.id, 'whatsapp_send', { conversationId: 'x', text: 'hi' });
    expect(droppedReplyReason(staff, conversation, configured)).toBeUndefined();
  });

  it('keeps the existing reasons for a switched-off bot and a staff takeover', () => {
    const now = new Date().toISOString();
    expect(droppedReplyReason(job('bot', now), base(), { ...configured, botEnabled: false })).toBe(
      'Not sent: the bot was switched off before the reply went out.',
    );
    expect(droppedReplyReason(job('bot', now), { ...base(), mode: 'human' }, configured)).toBe(
      'Not sent: staff took over this chat before the reply went out.',
    );
    expect(droppedReplyReason(job('bot', now), base(), configured)).toBeUndefined();
  });
});

describe('blocking a number', () => {
  const request = (path: string, method = 'GET', body?: unknown) =>
    createApp(repo).request(`http://127.0.0.1:4000/api${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-company-id': company.id,
        Origin: 'http://127.0.0.1:5173',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  async function savedChat(overrides: Partial<Conversation> = {}) {
    const chat = { ...newCustomer(), customerName: 'Spammer', ...overrides, version: 1 };
    await repo.saveConversation(chat, 0);
    return chat;
  }

  it('blocks from the chat, lists the block, and unblocks', async () => {
    const chat = await savedChat({ mode: 'human' });
    const blocked = await request(`/conversations/${chat.id}/block`, 'POST', { blocked: true });
    expect(blocked.status).toBe(200);
    const updated = (await blocked.json()) as Conversation;
    expect(updated.blocked).toBeDefined();
    expect(updated.mode).toBe('bot');
    expect(updated.version).toBe(2);

    const list = (await (await request('/blocked')).json()) as {
      blockId: string;
      keys: string[];
    }[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ label: 'Spammer', keys: [`pn:${chat.customerPhone}`] });

    expect(
      (await request(`/conversations/${chat.id}/mode`, 'POST', { mode: 'human' })).status,
    ).toBe(409);
    expect((await request(`/blocked/${list[0]!.blockId}`, 'DELETE')).status).toBe(200);
    expect((await repo.getConversation(company.id, chat.id))!.blocked).toBeUndefined();
    expect(await (await request('/blocked')).json()).toEqual([]);
    expect((await request(`/blocked/${list[0]!.blockId}`, 'DELETE')).status).toBe(404);
  });

  it('unblocks from the chat itself', async () => {
    const chat = await savedChat();
    await request(`/conversations/${chat.id}/block`, 'POST', { blocked: true });
    const response = await request(`/conversations/${chat.id}/block`, 'POST', { blocked: false });
    expect(((await response.json()) as Conversation).blocked).toBeUndefined();
    expect(
      await repo.findBlockedCustomer(company.id, [`pn:${chat.customerPhone}`]),
    ).toBeUndefined();
  });

  it('keeps one block per person, so unblocking from any of their chats unblocks them', async () => {
    // The same customer in two chats, for example before and after WhatsApp reconnected.
    const first = await savedChat({ customerPhone: '923004445556' });
    const second = await savedChat({
      customerPhone: '+923004445556',
      whatsappAddress: {
        connectionId: randomUUID(),
        generation: 2,
        provider: 'baileys',
        peer: '100000777@lid',
      },
    });
    await request(`/conversations/${first.id}/block`, 'POST', { blocked: true });
    await request(`/conversations/${second.id}/block`, 'POST', { blocked: true });
    const blocks = await repo.listBlockedCustomers(company.id);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.keys).toEqual(['lid:100000777', 'pn:923004445556']);
    const response = await request(`/conversations/${first.id}/block`, 'POST', {
      blocked: false,
    });
    expect(((await response.json()) as Conversation).blocked).toBeUndefined();
    expect(await repo.listBlockedCustomers(company.id)).toEqual([]);
    expect((await repo.getConversation(company.id, second.id))!.blocked).toBeUndefined();
    expect(await repo.findBlockedCustomer(company.id, ['lid:100000777'])).toBeUndefined();
  });

  it('leaves a blocked chat out of "Needs staff" when one of its queued messages fails', async () => {
    const chat = await savedChat();
    await repo.blockCustomer(company.id, chat.id, 'b1', [`pn:${chat.customerPhone}`], 'x', 'u');
    // A message stuck after five worker crashes fails for good.
    const stuck = {
      ...makeJob(company.id, 'incoming', {
        phone: chat.customerPhone,
        messageId: 'stuck-1',
        text: 'spam',
      }),
      attempts: 5,
    };
    await repo.insertJob(stuck);
    await processJob(repo, stuck.id).catch(() => undefined);
    // It no longer holds back the number's later messages, but the blocked chat stays as it is.
    expect((await repo.getJob(stuck.id))!).toMatchObject({
      status: 'done',
      payload: { failedPermanently: true },
    });
    const saved = (await repo.getConversation(company.id, chat.id))!;
    expect(saved.messages.some((m) => m.id === 'stuck-1')).toBe(false);
    expect(saved.mode).toBe('bot');
    expect(saved.blocked).toBeDefined();
    expect((await repo.staffAttention(company.id)).handoffs).toBe(0);
  });

  it('refuses to block a test chat', async () => {
    const chat = createConversation(company.id, 'demo-abc', 'demo', new Date().toISOString());
    await repo.saveConversation({ ...chat, version: 1 }, 0);
    expect(
      (await request(`/conversations/${chat.id}/block`, 'POST', { blocked: true })).status,
    ).toBe(400);
  });

  it('drops a message queued before the block without answering it', async () => {
    const chat = await savedChat();
    const queued = makeJob(company.id, 'incoming', {
      phone: chat.customerPhone,
      messageId: 'queued-1',
      text: 'menu',
    });
    await repo.insertJob(queued);
    await repo.blockCustomer(
      company.id,
      chat.id,
      'block-1',
      [`pn:${chat.customerPhone}`],
      'x',
      'u',
    );
    await processJob(repo, queued.id);
    expect((await repo.getJob(queued.id))!.status).toBe('done');
    expect((await repo.getConversation(company.id, chat.id))!.messages).toHaveLength(0);
    expect(generate).not.toHaveBeenCalled();
    expect((await repo.listBlockedCustomers(company.id))[0]!.blockedCount).toBe(1);
  });

  it('still records staff messages sent from the business phone', async () => {
    const chat = await savedChat();
    await repo.blockCustomer(
      company.id,
      chat.id,
      'block-1',
      [`pn:${chat.customerPhone}`],
      'x',
      'u',
    );
    const echo = makeJob(company.id, 'incoming', {
      phone: chat.customerPhone,
      messageId: 'echo-1',
      text: 'Please stop.',
      echo: true,
    });
    await repo.insertJob(echo);
    await processJob(repo, echo.id);
    expect((await repo.getConversation(company.id, chat.id))!.messages.at(-1)).toMatchObject({
      role: 'staff',
      text: 'Please stop.',
    });
  });

  it('drops blocked senders at the Meta webhook, but keeps echoes and other customers', async () => {
    vi.stubEnv('APP_MODE', 'live');
    vi.stubEnv('META_APP_SECRET', 'test-app-secret');
    await repo.saveIntegration(
      company.id,
      {
        kind: 'whatsapp',
        configured: true,
        status: 'configured',
        config: { phoneNumberId: '123' },
      },
      encryptSecret('token'),
    );
    await repo.blockCustomer(
      company.id,
      (await savedChat()).id,
      'block-1',
      ['pn:923009999999'],
      'x',
      'u',
    );
    const post = (value: Record<string, unknown>, field = 'messages') => {
      const body = JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [
          { changes: [{ field, value: { metadata: { phone_number_id: '123' }, ...value } }] },
        ],
      });
      return createApp(repo).request('http://127.0.0.1/api/webhooks/whatsapp', {
        method: 'POST',
        body,
        headers: {
          'x-hub-signature-256': `sha256=${createHmac('sha256', 'test-app-secret').update(body).digest('hex')}`,
        },
      });
    };
    const text = (id: string, from: string) => ({
      id,
      from,
      timestamp: String(Math.floor(Date.now() / 1000)),
      text: { body: 'spam' },
    });
    expect((await post({ messages: [text('w1', '923009999999')] })).status).toBe(200);
    expect(await repo.listCompanyJobs(company.id)).toHaveLength(0);
    expect((await post({ messages: [text('w2', '923001111111')] })).status).toBe(200);
    expect(
      (
        await post(
          { message_echoes: [{ id: 'e1', to: '923009999999', text: { body: 'Stop please.' } }] },
          'smb_message_echoes',
        )
      ).status,
    ).toBe(200);
    const jobs = await repo.listCompanyJobs(company.id);
    expect(jobs.map((job) => job.payload.messageId).sort()).toEqual(['e1', 'w2']);
  });

  it('drops blocked senders from the linked phone, learning their number as it appears', async () => {
    vi.stubEnv('WHATSAPP_GATEWAY_ENABLED', 'true');
    const connection: WhatsAppConnection = {
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
    const chat = await savedChat({
      customerPhone: '',
      whatsappAddress: {
        connectionId: connection.id,
        generation: 1,
        provider: 'baileys',
        peer: '100000001@lid',
      },
    });
    const response = await request(`/conversations/${chat.id}/block`, 'POST', { blocked: true });
    expect(((await response.json()) as Conversation).blocked).toBeDefined();
    const event = (overrides: Record<string, unknown>) =>
      gatewayEventSchema.parse({
        eventId: randomUUID(),
        connectionId: connection.id,
        generation: 1,
        type: 'message',
        peer: '100000001@lid',
        messageId: randomUUID(),
        text: 'spam',
        fromMe: false,
        timestamp: new Date().toISOString(),
        ...overrides,
      });
    await receiveGatewayEvent(repo, event({ phoneNumber: '+923007777777' }));
    expect(await repo.listCompanyJobs(company.id)).toHaveLength(0);
    // The number shared with that message is now blocked too, even under a new privacy ID.
    await receiveGatewayEvent(
      repo,
      event({ peer: '923007777777@s.whatsapp.net', messageId: randomUUID() }),
    );
    expect(await repo.listCompanyJobs(company.id)).toHaveLength(0);
    await receiveGatewayEvent(repo, event({ fromMe: true, text: 'Stop please.' }));
    expect(await repo.listCompanyJobs(company.id)).toHaveLength(1);
    const [block] = await repo.listBlockedCustomers(company.id);
    expect(block).toMatchObject({ keys: ['lid:100000001', 'pn:923007777777'], blockedCount: 2 });
  });
});

describe('shared helpers', () => {
  it('turns phone numbers and WhatsApp IDs into block keys', () => {
    expect(customerKeys({ phone: '923001234567' })).toEqual(['pn:923001234567']);
    expect(customerKeys({ phone: '+92 300-1234567' })).toEqual(['pn:923001234567']);
    expect(customerKeys({ phone: '', peer: '100000001@lid' })).toEqual(['lid:100000001']);
    expect(customerKeys({ peer: '923001234567@s.whatsapp.net' })).toEqual(['pn:923001234567']);
    expect(customerKeys({ peer: '923001234567:12@s.whatsapp.net' })).toEqual(['pn:923001234567']);
    expect(customerKeys({ phone: '+923001234567', peer: '923001234567' })).toEqual([
      'pn:923001234567',
    ]);
    expect(customerKeys({ phone: 'demo-abc123' })).toEqual([]);
    expect(customerKeys({ phone: '0300' })).toEqual([]);
  });

  it('uses defaults for missing or invalid limit settings', () => {
    expect(effectiveAiLimits()).toEqual(AI_LIMIT_DEFAULTS);
    expect(effectiveAiLimits({ repliesPerHour: 50, repliesPerCustomerPerHour: 10 })).toEqual({
      repliesPerHour: 50,
      repliesPerCustomerPerHour: 10,
      messagesPerCustomerPerMinute: AI_LIMIT_DEFAULTS.messagesPerCustomerPerMinute,
    });
    expect(effectiveAiLimits({ repliesPerHour: '50', repliesPerCustomerPerHour: 2.5 })).toEqual(
      AI_LIMIT_DEFAULTS,
    );
    expect(effectiveAiLimits({ repliesPerHour: 5, repliesPerCustomerPerHour: 5000 })).toEqual(
      AI_LIMIT_DEFAULTS,
    );
  });

  it('words the notice for the customer’s order', () => {
    const cart = newCustomer().cart;
    expect(limitNotice('en', cart)).toBe(NOTICE);
    expect(limitNotice('en', { ...cart, orderId: 'o1' })).toBe(
      `${NOTICE} Your order is not affected.`,
    );
    expect(
      limitNotice('en', {
        ...cart,
        items: [{ productId: 'p', name: 'Burger', quantity: 1, unitPrice: 1, modifiers: [] }],
      } as unknown as typeof cart),
    ).toBe(`${NOTICE} Your order hasn’t been placed yet.`);
    expect(limitNotice('ur', cart)).toBe('آپ کے پیغام کا شکریہ! ہماری ٹیم جلد یہیں جواب دے گی۔');
  });

  it('only resumes a paused chat that staff did not touch', () => {
    const pause = {
      reason: 'customer' as const,
      at: '2026-10-16T10:00:00.000Z',
      until: '2026-10-16T11:00:00.000Z',
      limit: AI_LIMIT_DEFAULTS.repliesPerCustomerPerHour,
    };
    const paused: Conversation = { ...newCustomer(), mode: 'human', limitPause: pause };
    const at = (iso: string) => Date.parse(iso);
    expect(limitPaused(paused)).toBe(true);
    expect(resumesAfterLimit(paused, configured, at('2026-10-16T10:30:00.000Z'))).toBe(false);
    expect(resumesAfterLimit(paused, configured, at('2026-10-16T11:00:00.000Z'))).toBe(true);
    const staffWrote: Conversation = {
      ...paused,
      messages: [{ id: 's', role: 'staff', text: 'hi', createdAt: '2026-10-16T10:05:00.000Z' }],
    };
    expect(limitPaused(staffWrote)).toBe(false);
    expect(resumesAfterLimit(staffWrote, configured, at('2026-10-16T12:00:00.000Z'))).toBe(false);
    const monthly: Conversation = {
      ...paused,
      limitPause: { ...pause, reason: 'monthly', limit: 0, until: '2026-11-01T00:00:00.000Z' },
    };
    expect(
      resumesAfterLimit(
        monthly,
        { ...configured, ai: { ...configured.ai, monthlyBudgetUsd: 0 } },
        at('2026-10-16T12:00:00.000Z'),
      ),
    ).toBe(false);
    expect(resumesAfterLimit(monthly, configured, at('2026-10-16T12:00:00.000Z'))).toBe(true);
  });
});

describe('limit settings', () => {
  const put = (body: unknown) =>
    createApp(repo).request(`http://127.0.0.1:4000/api/companies/${company.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-company-id': company.id,
        Origin: 'http://127.0.0.1:5173',
      },
      body: JSON.stringify(body),
    });
  const { modelVerification: _verification, bot: _bot, ...editable } = seedCompanies[0]!;

  it('saves the limits and keeps them when a later save leaves them out', async () => {
    const limits = { repliesPerHour: 120, repliesPerCustomerPerHour: 15 };
    expect((await put({ ...editable, aiLimits: limits })).status).toBe(200);
    expect((await repo.getCompany(company.id))!.aiLimits).toEqual(limits);
    expect((await put({ ...editable, name: 'Renamed' })).status).toBe(200);
    expect((await repo.getCompany(company.id))!.aiLimits).toEqual(limits);
    expect((await repo.aiLimitStatus(company.id)).repliesPerHour).toBe(120);
  });

  it.each([
    { repliesPerHour: 10, repliesPerCustomerPerHour: 15 },
    { repliesPerHour: 120, repliesPerCustomerPerHour: 1001 },
    { repliesPerHour: 120.5, repliesPerCustomerPerHour: 15 },
    { repliesPerHour: 120, repliesPerCustomerPerHour: 15, extra: 1 },
  ])('refuses limits outside their ranges: %o', async (aiLimits) => {
    expect((await put({ ...editable, aiLimits })).status).toBe(400);
  });
});
