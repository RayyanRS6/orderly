import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MemoryRepository } from '../server/repository';
import { encryptSecret } from '../server/security';
import { droppedReplyReason, handleTurn, processJob } from '../server/service';
import { makeJob } from '../server/jobs';
import { modelFingerprint } from '../server/integrations/model-catalog';
import { createConversation, processTurn } from '../src/domain/engine';
import { disclosureLine } from '../src/domain/disclosure';
import { defaultBot } from '../src/shared/bot';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import type {
  BotAction,
  Company,
  Conversation,
  Job,
  ModelInterpretation,
  Order,
  Product,
} from '../src/shared/types';

const { generate } = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: generate,
  Output: { object: vi.fn() },
}));

const company = seedCompanies[0]!;
const products = seedProducts.filter((p) => p.companyId === company.id);
const biryani = products.find((p) => p.name === 'Chicken Biryani')!;
const key = 'fictional-anthropic-key';
const ai = (interpretation: ModelInterpretation) =>
  generate.mockResolvedValue({
    output: interpretation,
    usage: { inputTokens: 1000, outputTokens: 50 },
  });
const menu: ModelInterpretation = {
  actions: [{ type: 'menu' }],
  response: { text: 'Here is our menu.', askFor: 'items' },
};
let repo: MemoryRepository;
let configured: Company;

beforeEach(async () => {
  generate.mockReset();
  ai(menu);
  repo = new MemoryRepository();
  vi.stubEnv('APP_MODE', 'demo');
  vi.stubEnv('ORDERLY_RUNTIME', '');
  vi.stubEnv('VERCEL', '');
  vi.stubEnv('APP_URL', 'http://127.0.0.1:5173');
  vi.stubEnv('MODEL_PRICING_JSON', '');
  vi.stubEnv('ORDERLY_PAUSE_AUTOMATION', '');
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

let phoneCounter = 0;
const newCustomer = () =>
  createConversation(
    company.id,
    `9230044${String(++phoneCounter).padStart(5, '0')}`,
    'whatsapp',
    '1970-01-01T00:00:00.000Z',
  );
const saved = async (c: Conversation) => (await repo.getConversation(company.id, c.id))!;
async function message(
  conversation: Conversation,
  text: string,
  extra: Partial<Parameters<typeof handleTurn>[3]> = {},
) {
  const current = (await repo.getConversation(company.id, conversation.id)) ?? conversation;
  const result = await handleTurn(repo, configured, current, {
    messageId: randomUUID(),
    text,
    now: new Date().toISOString(),
    ...extra,
  });
  return { result, saved: await saved(conversation) };
}
// A chat whose order was placed and saved, as a chat or menu-page order leaves it.
async function placedOrder(status: Order['status'] = 'pending') {
  let c: Conversation = { ...newCustomer(), version: 0 };
  const step = (action: BotAction) => {
    const result = processTurn(configured, products, c, {
      messageId: randomUUID(),
      text: action.type === 'confirm' ? 'confirm' : 'step',
      action,
      now: new Date().toISOString(),
    });
    c = result.conversation;
    return result;
  };
  step({ type: 'add_item', productId: biryani.id, quantity: 1 });
  step({ type: 'set_details', customerName: 'Ali Raza', fulfillment: 'pickup' });
  step({ type: 'review' });
  const placed = step({ type: 'confirm' });
  c.version = 1;
  await repo.commitTurn(company.id, c, 0, placed.order);
  if (status !== 'pending') await repo.saveOrder({ ...placed.order!, status });
  return {
    conversation: await saved(c),
    order: (await repo.getOrder(company.id, placed.order!.id))!,
  };
}
const sends = async () =>
  (await repo.listCompanyJobs(company.id)).filter((job) => job.kind === 'whatsapp_send');

describe('F35: a returning customer can order again without “new order”', () => {
  const addTwo: ModelInterpretation = {
    actions: [{ type: 'add_item', productId: biryani.id, quantity: 2 }],
    response: { text: 'Anything else?', askFor: 'anything_else' },
  };

  it.each(['completed', 'rejected', 'cancelled'] as const)(
    'starts a fresh cart after a %s order, before the AI reads it',
    async (status) => {
      const { conversation } = await placedOrder(status);
      ai(addTwo);
      const { result, saved: after } = await message(conversation, '2 chicken biryani');
      expect(after.cart).toMatchObject({ status: 'building', items: [{ quantity: 2 }] });
      expect(after.cart.orderId).toBeUndefined();
      expect(after.cart.revision).toBeGreaterThan(conversation.cart.revision);
      expect(result.traces).not.toContain('duplicate_submission_prevented');
      // The AI was asked about the fresh cart, not yesterday's order.
      expect(generate.mock.calls[0]![0].prompt).toContain('"status":"building"');
    },
  );

  it('starts a fresh cart after the customer cancelled', async () => {
    const { conversation } = await placedOrder();
    await message(conversation, 'cancel');
    expect((await saved(conversation)).cart.status).toBe('cancelled');
    ai(addTwo);
    const { saved: after } = await message(conversation, '2 chicken biryani');
    expect(after.cart).toMatchObject({ status: 'building', items: [{ quantity: 2 }] });
  });

  it('keeps an order still with the restaurant as it is', async () => {
    const { conversation } = await placedOrder('pending');
    ai(addTwo);
    const { result, saved: after } = await message(conversation, '2 chicken biryani');
    expect(after.cart.status).toBe('submitted');
    expect(result.reply).toContain('already been submitted');
  });

  it('leaves a cancel request about a finished order to staff, with its cart', async () => {
    const { conversation } = await placedOrder('completed');
    const { saved: after } = await message(conversation, 'cancel my order');
    expect(after.cart.status).toBe('submitted');
    expect(after.mode).toBe('human');
    expect(generate).not.toHaveBeenCalled();
  });
});

describe('G3.10: “where is my order?” gets the order’s real status', () => {
  it.each([
    ['accepted', 'The restaurant has accepted order'],
    ['completed', 'is completed'],
  ] as const)('answers for an order that is %s', async (status, wording) => {
    const { conversation, order } = await placedOrder(status);
    ai({
      actions: [{ type: 'answer', text: '' }],
      response: { text: 'It is on its way!', askFor: 'none' },
    });
    const { result, saved: after } = await message(conversation, 'where is my order?');
    expect(result.traces).toContain('order_status');
    expect(result.reply).toContain(order.reference);
    expect(result.reply).toContain(wording);
    expect(result.reply).not.toContain('on its way');
    expect(after.mode).toBe('bot');
    // A status question about a finished order keeps it: the next message starts afresh.
    expect(after.cart.orderId).toBe(order.id);
  });
});

describe('F36: a customer cancels a waiting order in their own words', () => {
  it.each([
    'Cancel.',
    'cancel karo',
    'please cancel my order',
    'order cancel kar dein please',
    'آرڈر منسوخ کر دیں',
  ])('cancels on “%s” without the AI', async (text) => {
    const { conversation, order } = await placedOrder();
    const { result, saved: after } = await message(conversation, text);
    expect(result.order?.status).toBe('cancelled');
    expect((await repo.getOrder(company.id, order.id))!.status).toBe('cancelled');
    expect(after.mode).toBe('bot');
    expect(generate).not.toHaveBeenCalled();
  });

  it.each(["don't cancel my order", 'cancel mat karo', 'cancel the raita'])(
    'does not cancel on “%s”',
    async (text) => {
      const { conversation, order } = await placedOrder();
      await message(conversation, text);
      expect((await repo.getOrder(company.id, order.id))!.status).toBe('pending');
    },
  );
});

describe('G7.2: a message handled late is still answered, carefully', () => {
  const incoming = (phone: string, text: string, minutesAgo: number): Job => ({
    ...makeJob(company.id, 'incoming', { phone, messageId: `wamid-${randomUUID()}`, text }),
    createdAt: new Date(Date.now() - minutesAgo * 60000).toISOString(),
  });
  const run = async (job: Job) => {
    await repo.insertJob(job);
    await processJob(repo, job.id);
    expect((await repo.getJob(job.id))!.status).toBe('done');
  };
  const chat = async (phone: string) =>
    (await repo.findConversation(company.id, phone, 'whatsapp'))!;

  it('answers a message 11 minutes late normally', async () => {
    const phone = '923004400001';
    await run(incoming(phone, 'menu please', 11));
    const after = await chat(phone);
    expect(after.mode).toBe('bot');
    expect(after.messages.at(-1)).toMatchObject({ role: 'assistant' });
    expect(after.messages.at(-1)!.text).toContain('Here is our menu.');
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('asks again before placing an order from a late confirmation', async () => {
    // A chat with a reviewed cart, built through the engine.
    let c: Conversation = { ...newCustomer(), version: 0 };
    for (const action of [
      { type: 'add_item', productId: biryani.id, quantity: 1 },
      { type: 'set_details', customerName: 'Sara Khan', fulfillment: 'pickup' },
      { type: 'review' },
    ] as BotAction[])
      c = processTurn(configured, products, c, {
        messageId: randomUUID(),
        text: 'step',
        action,
        now: new Date().toISOString(),
      }).conversation;
    c.version = 1;
    await repo.commitTurn(company.id, c, 0);
    ai({ actions: [{ type: 'confirm' }], response: { text: '', askFor: 'none' } });
    const before = (await repo.listOrders(company.id)).length;
    await run(incoming(c.customerPhone, 'confirm', 30));
    expect((await repo.listOrders(company.id)).length).toBe(before);
    const after = await chat(c.customerPhone);
    expect(after.mode).toBe('bot');
    expect(after.messages.at(-1)!.text).toContain('Sorry for the delay');
  });

  it('leaves a message hours late to staff, then gives the chat back on the next message', async () => {
    const phone = '923004400002';
    await run(incoming(phone, 'menu please', 3 * 60));
    let after = await chat(phone);
    expect(after.mode).toBe('human');
    expect(after.limitPause).toMatchObject({ reason: 'late' });
    expect(after.messages.at(-1)!.text).toContain(
      'Sorry, your message reached us late. Our team will reply here soon.',
    );
    expect(after.messages.at(-1)!.explanation?.ai).toEqual({ called: false, skipped: 'late' });
    expect(generate).not.toHaveBeenCalled();
    // More of the same backlog is saved for staff, without replies.
    const count = after.messages.length;
    await run(incoming(phone, 'hello?', 2.5 * 60));
    after = await chat(phone);
    expect(after.messages).toHaveLength(count + 1);
    expect(after.mode).toBe('human');
    // A message on time goes to the bot again.
    await run(incoming(phone, 'menu please', 0));
    after = await chat(phone);
    expect(after.mode).toBe('bot');
    expect(after.messages.at(-1)!.text).toContain('Here is our menu.');
  });

  it('keeps a chat paused while the bot is off when a late message arrives', async () => {
    await repo.saveCompany({ ...configured, botEnabled: false });
    const phone = '923004400003';
    await run(incoming(phone, 'hi', 1));
    expect((await chat(phone)).botPausedAt).toBeTruthy();
    await run(incoming(phone, 'hello?', 30));
    const after = await chat(phone);
    expect(after.botPausedAt).toBeTruthy();
    expect(after.mode).toBe('human');
  });
});

describe('G7.8: an order confirmation always reaches the customer', () => {
  it('queues the confirmation as a notice that switching the bot off does not drop', async () => {
    let c: Conversation = { ...newCustomer(), version: 0 };
    for (const action of [
      { type: 'add_item', productId: biryani.id, quantity: 1 },
      { type: 'set_details', customerName: 'Sara Khan', fulfillment: 'pickup' },
    ] as BotAction[])
      c = processTurn(configured, products, c, {
        messageId: randomUUID(),
        text: 'step',
        action,
        now: new Date().toISOString(),
      }).conversation;
    c.version = 1;
    await repo.commitTurn(company.id, c, 0);
    ai({ actions: [{ type: 'review' }], response: { text: '', askFor: 'none' } });
    await message(c, 'that is all');
    ai({ actions: [{ type: 'confirm' }], response: { text: '', askFor: 'none' } });
    const confirmed = await message(c, 'confirm');
    expect(confirmed.result.order).toBeDefined();
    const job = (await sends()).find((j) => String(j.payload.text).includes('received'))!;
    expect(job.payload.source).toBe('notice');
    const off = { ...configured, botEnabled: false };
    expect(droppedReplyReason(job, confirmed.saved, off)).toBeUndefined();
    expect(
      droppedReplyReason(job, { ...confirmed.saved, mode: 'human' }, configured),
    ).toBeUndefined();
    // An ordinary bot reply is still not sent once the bot is off.
    const reply = (await sends()).find((j) => j.payload.source === 'bot')!;
    expect(droppedReplyReason(reply, confirmed.saved, off)).toMatch(/switched off/);
  });
});

describe('G6.3: the platform-wide automation pause', () => {
  it('saves messages for staff with no AI and no reply, and resumes when lifted', async () => {
    vi.stubEnv('ORDERLY_PAUSE_AUTOMATION', 'on');
    const customer = newCustomer();
    const paused = await message(customer, 'menu please');
    expect(paused.result.reply).toBe('');
    expect(generate).not.toHaveBeenCalled();
    expect(paused.saved.mode).toBe('human');
    expect(paused.saved.botPausedAt).toBeTruthy();
    expect(paused.saved.messages.at(-1)).toMatchObject({ role: 'customer', text: 'menu please' });
    expect(await sends()).toHaveLength(0);
    // A queued bot reply is not sent; staff replies and notices still are.
    const job = (source?: string) =>
      makeJob(company.id, 'whatsapp_send', { conversationId: customer.id, text: 'x', source });
    const bot = { ...paused.saved, mode: 'bot' as const, botPausedAt: undefined };
    expect(droppedReplyReason(job('bot'), bot, configured)).toMatch(/switched off/);
    expect(droppedReplyReason(job('notice'), bot, configured)).toBeUndefined();
    expect(droppedReplyReason(job(), bot, configured)).toBeUndefined();
    // Test chats stop too.
    await expect(
      handleTurn(
        repo,
        configured,
        createConversation(company.id, 'demo-x', 'demo', new Date().toISOString()),
        {
          messageId: randomUUID(),
          text: 'menu',
          now: new Date().toISOString(),
        },
      ),
    ).rejects.toMatchObject({ status: 503 });
    for (const value of ['true', '1', ' ON ']) {
      vi.stubEnv('ORDERLY_PAUSE_AUTOMATION', value);
      expect((await message(newCustomer(), 'hi')).result.reply).toBe('');
    }
    vi.stubEnv('ORDERLY_PAUSE_AUTOMATION', '');
    const back = await message(customer, 'menu please');
    expect(back.saved.mode).toBe('bot');
    expect(back.result.reply).toContain('Here is our menu.');
  });
});

describe('F12: customers are told they are talking to an automated assistant', () => {
  it.each([
    ['en', 'what do you have?'],
    ['roman-ur', 'mujhe menu chahiye'],
    ['ur', 'مینو دکھائیں'],
  ] as const)('starts a %s chat with the notice, once a day', async (lang, text) => {
    await repo.saveCompany({
      ...configured,
      bot: { draft: { ...defaultBot, language: 'auto' }, revision: 1, history: [] },
    });
    configured = (await repo.getCompany(company.id))!;
    const customer = newCustomer();
    const first = await message(customer, text);
    expect(first.result.reply.startsWith(`${disclosureLine(company.name, lang)}\n\n`)).toBe(true);
    // What is stored is what is sent, so the next turn knows it went out.
    expect(first.saved.messages.at(-1)!.text).toBe(first.result.reply);
    expect((await sends()).at(-1)!.payload.text).toBe(first.result.reply);
    const second = await message(customer, text);
    expect(second.result.reply).not.toContain(disclosureLine(company.name, lang));
  });

  it('hands “staff” to a person without the AI, but not “per person”', async () => {
    const asked = await message(newCustomer(), 'Staff!');
    expect(asked.saved.mode).toBe('human');
    expect(asked.result.traces).toContain('handoff');
    expect(generate).not.toHaveBeenCalled();
    const order = await message(newCustomer(), '2 biryani per person');
    expect(order.saved.mode).toBe('bot');
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('keeps the Confirm button on a long first review, and tells the customer next time', async () => {
    // Find a dish name that makes the review fit WhatsApp's 1,024 characters only without
    // the notice.
    const notice = `${disclosureLine(company.name, 'en')}\n\n`.length;
    const text = 'the big platter for pickup, Sara Khan, that is all';
    const proposal = (dish: Product): ModelInterpretation => ({
      actions: [
        { type: 'add_item', productId: dish.id, quantity: 1 },
        { type: 'set_details', customerName: 'Sara Khan', fulfillment: 'pickup' },
        { type: 'review' },
      ],
      response: { text: '', askFor: 'none' },
    });
    const reviewFor = (dish: Product) =>
      processTurn(
        configured,
        [...products, dish],
        newCustomer(),
        { messageId: randomUUID(), text, now: new Date().toISOString() },
        proposal(dish).actions,
        proposal(dish).response,
      ).reply;
    let dish: Product | undefined;
    for (let length = 1; length < 1000 && !dish; length += 1) {
      const candidate = {
        ...biryani,
        id: '33333333-3333-4333-a333-000000000777',
        name: `Platter ${'x'.repeat(length)}`,
        aliases: [],
      };
      const size = reviewFor(candidate).length;
      if (size <= 1024 && size + notice > 1024) dish = candidate;
    }
    expect(dish).toBeDefined();
    await repo.saveProduct(dish!);
    ai(proposal(dish!));
    const customer = newCustomer();
    const review = await message(customer, text);
    expect(review.saved.cart.status).toBe('awaiting_confirmation');
    expect(review.result.reply.length).toBeLessThanOrEqual(1024);
    expect(review.result.reply).not.toContain(disclosureLine(company.name, 'en'));
    ai(menu);
    const next = await message(customer, 'what else do you have?');
    expect(next.result.reply.startsWith(disclosureLine(company.name, 'en'))).toBe(true);
  });
});
