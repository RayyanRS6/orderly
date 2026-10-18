import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { APICallError, RetryError } from 'ai';
import { MemoryRepository } from '../server/repository';
import { encryptSecret } from '../server/security';
import { handleTurn, processJob } from '../server/service';
import { makeJob } from '../server/jobs';
import {
  AiCallError,
  AiModelAdapter,
  failedCallCharge,
  failureReason,
  StoreUnavailableError,
} from '../server/integrations/models';
import { modelFingerprint } from '../server/integrations/model-catalog';
import { aiErrorNotice, createConversation } from '../src/domain/engine';
import { disclosureLine } from '../src/domain/disclosure';
import { defaultBot } from '../src/shared/bot';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import type { Company, Conversation, ModelInterpretation } from '../src/shared/types';

const { generate } = vi.hoisted(() => ({ generate: vi.fn() }));
// The real error classes stay: the adapter reads them to decide what to retry and charge.
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: generate,
  Output: { object: vi.fn() },
}));

const company = seedCompanies[0]!;
const products = seedProducts.filter((p) => p.companyId === company.id);
const key = 'fictional-anthropic-key';
const menu: ModelInterpretation = {
  actions: [{ type: 'menu' }],
  response: { text: 'Here is our menu.', askFor: 'items' },
};
const answered = { output: menu, usage: { inputTokens: 1200, outputTokens: 80 } };
const refused = (status: number, body = '{"type":"error"}', headers?: Record<string, string>) =>
  new APICallError({
    message: 'refused',
    url: 'https://api.anthropic.com/v1/messages',
    requestBodyValues: {},
    statusCode: status,
    responseBody: body,
    responseHeaders: headers,
  });
// The provider asked for no wait, so the retries run at once in tests.
const busy = (status = 529) => refused(status, '{"type":"error"}', { 'retry-after-ms': '1' });
let repo: MemoryRepository;
let configured: Company;

beforeEach(async () => {
  generate.mockReset();
  generate.mockResolvedValue(answered);
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

let phoneCounter = 0;
const newCustomer = () =>
  createConversation(
    company.id,
    `9230022${String(++phoneCounter).padStart(5, '0')}`,
    'whatsapp',
    '1970-01-01T00:00:00.000Z',
  );
async function message(conversation: Conversation, text = 'what do you have?') {
  const current = (await repo.getConversation(company.id, conversation.id)) ?? conversation;
  const result = await handleTurn(repo, configured, current, {
    messageId: randomUUID(),
    text,
    now: new Date().toISOString(),
  });
  return { result, saved: (await repo.getConversation(company.id, conversation.id))! };
}
const interpret = () =>
  new AiModelAdapter(repo).interpret(
    configured,
    products,
    createConversation(company.id, '923000000999', 'demo', new Date().toISOString()),
    'what do you have?',
  );

describe('F42/G4.3: a refused AI call is tried again, only when it cost nothing', () => {
  it('answers after one overloaded refusal and bills only the answer', async () => {
    generate.mockRejectedValueOnce(busy(529)).mockResolvedValueOnce(answered);
    const { result, saved } = await message(newCustomer());
    expect(generate).toHaveBeenCalledTimes(2);
    expect(saved.mode).toBe('bot');
    expect(result.reply).toContain('Here is our menu.');
    const usage = await repo.listUsage(company.id);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ inputTokens: 1200, outputTokens: 80, estimated: false });
    expect(usage[0]!.rejected).toBeUndefined();
  });

  it('waits as long as the provider asks, at most twice', async () => {
    const limited = () => refused(429, '{"type":"rate_limit_error"}', { 'retry-after': '0.05' });
    generate
      .mockRejectedValueOnce(limited())
      .mockRejectedValueOnce(limited())
      .mockResolvedValueOnce(answered);
    const started = Date.now();
    const result = await interpret();
    expect(Date.now() - started).toBeGreaterThanOrEqual(95);
    expect(generate).toHaveBeenCalledTimes(3);
    expect(result.actions).toEqual(menu.actions);
    // Every try had its own share of the one 25 s deadline.
    for (const [call] of generate.mock.calls) expect(call.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('keeps the conservative charge when a retry fails in a way that may have been billed', async () => {
    generate.mockRejectedValueOnce(busy(503)).mockRejectedValueOnce(refused(500));
    await expect(interpret()).rejects.toMatchObject({ status: 503, reason: 'provider_error' });
    expect(generate).toHaveBeenCalledTimes(2);
    const [ledger] = await repo.listUsage(company.id);
    expect(ledger).toMatchObject({ estimated: true, outputTokens: 4000 });
    expect(ledger!.rejected).toBeUndefined();
    expect(ledger!.costUsd).toBeGreaterThan(0);
  });

  it('tries again when the provider could not even be reached, and bills nothing', async () => {
    const unreachable = new APICallError({
      message: 'Cannot connect to API: connect ECONNREFUSED',
      url: 'https://api.anthropic.com/v1/messages',
      requestBodyValues: {},
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), {
        code: 'ECONNREFUSED',
      }),
      isRetryable: true,
    });
    expect(failedCallCharge(unreachable)).toEqual({ kind: 'none' });
    expect(failureReason(unreachable)).toEqual({ reason: 'unreachable' });
    generate.mockRejectedValueOnce(unreachable).mockResolvedValueOnce(answered);
    await interpret();
    expect(generate).toHaveBeenCalledTimes(2);
    expect(await repo.listUsage(company.id)).toHaveLength(1);
  });

  it.each([
    ['a rejected key', refused(401, '{"error":"secret provider text"}'), 'auth', 401],
    ['a retired model', refused(404), 'model_not_found', 404],
    [
      'an account without credit',
      refused(429, '{"error":{"code":"insufficient_quota"}}'),
      'quota',
      429,
    ],
    [
      'a daily quota',
      refused(429, '{"error":{"details":[{"quotaId":"GenerateRequestsPerDayPerProject"}]}}'),
      'quota',
      429,
    ],
    ['a wait longer than 10 s', refused(429, '{}', { 'retry-after': '30' }), 'rate_limited', 429],
    [
      'a timeout',
      new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
      'timeout',
      undefined,
    ],
    ['a network failure mid-call', new TypeError('fetch failed'), 'provider_error', undefined],
  ] as const)(
    'does not try again after %s, and names the cause safely',
    async (_case, error, reason, status) => {
      generate.mockRejectedValue(error);
      const failure = await interpret().catch((e: unknown) => e);
      expect(generate).toHaveBeenCalledTimes(1);
      expect(failure).toBeInstanceOf(AiCallError);
      expect(failure).toMatchObject({ reason, httpStatus: status, status: 503 });
      const text = (failure as Error).message;
      if (status) expect(text).toContain(`(HTTP ${status})`);
      expect(text).not.toMatch(/secret provider text|insufficient_quota|quotaId/);
    },
  );

  it('unwraps an SDK retry error before deciding what the call cost', () => {
    const wrapped = new RetryError({
      message: 'Failed after 3 attempts.',
      reason: 'maxRetriesExceeded',
      errors: [refused(429), refused(429)],
    });
    expect(failedCallCharge(wrapped)).toEqual({ kind: 'none' });
    expect(failureReason(wrapped)).toEqual({ reason: 'rate_limited', status: 429 });
  });
});

describe('F42: a chat the AI could not answer goes back to the bot by itself', () => {
  it('tells the customer once, pauses for 10 minutes, then answers again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-16T10:00:00.000Z'));
    generate.mockRejectedValue(busy(529));
    const customer = newCustomer();
    const failed = await message(customer);
    expect(generate).toHaveBeenCalledTimes(3);
    // The first reply of the chat also says it is the automated assistant.
    expect(failed.result.reply).toBe(
      `${disclosureLine(company.name, 'en')}\n\n${aiErrorNotice('en', customer.cart)}`,
    );
    expect(failed.saved.mode).toBe('human');
    expect(failed.saved.limitPause).toMatchObject({
      reason: 'ai_error',
      until: '2026-10-16T10:10:00.000Z',
    });
    expect(failed.result.explanation).toMatchObject({ notice: 'ai_error', outcome: 'staff' });
    const trace = (await repo.listTraces(company.id)).find((t) => t.code === 'ai_overloaded');
    expect(trace?.detail).toContain('(HTTP 529)');
    expect(trace?.detail).not.toContain('{"type":"error"}');

    vi.setSystemTime(new Date('2026-10-16T10:05:00.000Z'));
    const waiting = await message(customer, 'hello?');
    expect(waiting.result.reply).toBe('');
    expect(waiting.saved.mode).toBe('human');
    expect(generate).toHaveBeenCalledTimes(3);

    generate.mockReset();
    generate.mockResolvedValue(answered);
    vi.setSystemTime(new Date('2026-10-16T10:10:30.000Z'));
    const back = await message(customer);
    expect(back.saved.mode).toBe('bot');
    expect(back.result.reply).toContain('Here is our menu.');
  });

  it('pauses only the customer it happened to', async () => {
    generate.mockRejectedValueOnce(refused(401));
    expect((await message(newCustomer())).saved.limitPause?.reason).toBe('ai_error');
    expect((await message(newCustomer())).saved.mode).toBe('bot');
  });

  it('stays with staff once staff wrote', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-16T10:00:00.000Z'));
    generate.mockRejectedValueOnce(refused(401));
    const customer = newCustomer();
    const failed = await message(customer);
    expect(failed.saved.limitPause?.reason).toBe('ai_error');
    vi.setSystemTime(new Date('2026-10-16T10:02:00.000Z'));
    await repo.saveConversation(
      {
        ...failed.saved,
        version: failed.saved.version + 1,
        messages: [
          ...failed.saved.messages,
          {
            id: 'staff-1',
            role: 'staff',
            text: 'I can help.',
            createdAt: new Date().toISOString(),
          },
        ],
      },
      failed.saved.version,
    );
    vi.setSystemTime(new Date('2026-10-16T10:30:00.000Z'));
    const later = await message(customer);
    expect(later.saved.mode).toBe('human');
    expect(later.result.reply).toBe('');
    expect(generate).toHaveBeenCalledTimes(1);
  });
});

describe('G4.4: a database hiccup around the AI call', () => {
  it('retries the message when the key could not be read, and pauses on the last try', async () => {
    const customer = newCustomer();
    const turn = (retryable: boolean) =>
      handleTurn(
        repo,
        configured,
        customer,
        { messageId: `m-${retryable}`, text: 'menu please', now: new Date().toISOString() },
        { retryable },
      );
    const getSecret = vi
      .spyOn(repo, 'getSecret')
      .mockRejectedValueOnce(new Error('Database operation failed: timeout'));
    await expect(turn(true)).rejects.toBeInstanceOf(StoreUnavailableError);
    expect(await repo.getConversation(company.id, customer.id)).toBeUndefined();
    expect(generate).not.toHaveBeenCalled();
    // The retry answers normally.
    expect((await turn(true)).reply).toContain('Here is our menu.');
    // On the job's last try the customer is told and the bot tries again later.
    getSecret.mockRejectedValueOnce(new Error('Database operation failed: timeout'));
    const last = await handleTurn(
      repo,
      configured,
      (await repo.getConversation(company.id, customer.id))!,
      { messageId: 'm-last', text: 'and drinks?', now: new Date().toISOString() },
      { retryable: false },
    );
    expect(last.conversation.limitPause?.reason).toBe('ai_error');
    expect((await repo.listTraces(company.id)).some((t) => t.code === 'store_unavailable')).toBe(
      true,
    );
  });

  it('lets the job retry an unreachable database, until its last tries', async () => {
    const customer = newCustomer();
    const incoming = (attempts: number) => ({
      ...makeJob(company.id, 'incoming', {
        phone: customer.customerPhone,
        messageId: `wamid-${attempts}`,
        text: 'menu please',
      }),
      attempts,
    });
    vi.spyOn(repo, 'reserveAiCall').mockRejectedValue(new Error('Database operation failed'));
    const early = incoming(0);
    await repo.insertJob(early);
    await expect(processJob(repo, early.id)).rejects.toMatchObject({ status: 503 });
    expect((await repo.getJob(early.id))!).toMatchObject({ status: 'pending', attempts: 1 });
    expect(
      await repo.findConversation(company.id, customer.customerPhone, 'whatsapp'),
    ).toBeUndefined();
    await repo.saveJob({ ...(await repo.getJob(early.id))!, status: 'done' });
    const late = incoming(3);
    await repo.insertJob(late);
    await processJob(repo, late.id);
    expect((await repo.getJob(late.id))!.status).toBe('done');
    const chat = (await repo.findConversation(company.id, customer.customerPhone, 'whatsapp'))!;
    expect(chat.limitPause?.reason).toBe('ai_error');
  });

  it('keeps a paid answer when recording its cost fails', async () => {
    vi.spyOn(repo, 'settleBudget').mockRejectedValue(new Error('Database operation failed'));
    const { result, saved } = await message(newCustomer());
    expect(result.reply).toContain('Here is our menu.');
    expect(saved.mode).toBe('bot');
    expect(
      (await repo.listTraces(company.id)).some((t) => t.action === 'budget.settle_failed'),
    ).toBe(true);
  });

  it('keeps a paid answer when its completion note cannot be saved', async () => {
    const addTrace = repo.addTrace.bind(repo);
    vi.spyOn(repo, 'addTrace').mockImplementation(async (trace) => {
      if (trace.action === 'model.completed') throw new Error('Database operation failed');
      return addTrace(trace);
    });
    const { result, saved } = await message(newCustomer());
    expect(result.reply).toContain('Here is our menu.');
    expect(saved.mode).toBe('bot');
    expect(await repo.listUsage(company.id)).toHaveLength(1);
  });

  it('keeps the real cause when a failed call cannot be settled either', async () => {
    generate.mockRejectedValue(refused(401));
    vi.spyOn(repo, 'settleBudget').mockRejectedValue(new Error('Database operation failed'));
    await expect(interpret()).rejects.toMatchObject({ reason: 'auth', httpStatus: 401 });
  });
});
