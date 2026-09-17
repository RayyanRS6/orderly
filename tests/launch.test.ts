import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app';
import { MemoryRepository } from '../server/repository';
import { defaultBot } from '../src/shared/bot';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import { createConversation, processTurn } from '../src/domain/engine';
import { handleTurn, processJob } from '../server/service';
import { encryptSecret } from '../server/security';
import { makeJob } from '../server/jobs';
import { availableModels } from '../server/integrations/model-catalog';
import { parseRoute, workspacePath } from '../src/lib/routes';
import type { BotAction, TurnResult } from '../src/shared/types';
let repo: MemoryRepository;
const company = seedCompanies[0];
beforeEach(() => {
  repo = new MemoryRepository();
  vi.stubEnv('APP_MODE', 'demo');
  vi.stubEnv('ORDERLY_RUNTIME', '');
  vi.stubEnv('VERCEL', '');
  vi.stubEnv('APP_URL', 'http://localhost:5173');
  vi.stubEnv('META_GRAPH_VERSION', 'v24.0');
  vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(Error('Unexpected external request'))),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function request(
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
  companyId = company.id,
) {
  return createApp(repo).request('http://localhost/api' + path, {
    method,
    headers: { 'x-company-id': companyId, 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
describe('launch safety and management', () => {
  it('pauses and clears approval before replacing an active provider key', async () => {
    await repo.saveCompany({
      ...company,
      ai: { ...company.ai, provider: 'gemini', model: 'gemini-3.5-flash-lite' },
      privacy: { aiDataApproved: true, retentionDays: 0 },
    });
    vi.spyOn(repo, 'saveIntegration').mockImplementationOnce(async () => {
      const current = await repo.getCompany(company.id);
      expect(current?.botEnabled).toBe(false);
      expect(current?.privacy?.aiDataApproved).toBe(false);
      throw Error('Storage unavailable');
    });
    expect(
      (await request('/integrations/gemini', { config: {}, secret: 'replacement-test-key' }))
        .status,
    ).toBe(500);
    expect((await repo.getCompany(company.id))?.botEnabled).toBe(false);
  });
  it('blocks a previously reviewed cart after fulfillment is restricted', () => {
    const now = '2026-09-16T10:00:00.000Z';
    let c = createConversation(company.id, '923000000000', 'demo', now);
    const turn = (action: BotAction, settings = company) => {
      const result = processTurn(
        settings,
        seedProducts.filter((p) => p.companyId === company.id),
        c,
        { messageId: randomUUID(), text: 'confirm', action, now },
      );
      c = result.conversation;
      return result;
    };
    turn({ type: 'add_item', productId: seedProducts[0].id, quantity: 1 });
    turn({ type: 'set_details', customerName: 'Test Customer', fulfillment: 'pickup' });
    turn({ type: 'review' });
    const config = { ...defaultBot, fulfillment: 'delivery' as const };
    const changed = {
      ...company,
      bot: {
        draft: config,
        revision: 1,
        history: [],
        published: { config, version: 1, publishedAt: now, publishedBy: 'test' },
      },
    };
    const result = turn({ type: 'confirm' }, changed);
    expect(result.order).toBeUndefined();
    expect(result.reply).toContain('delivery only');
  });
  it('does not resend an accepted WhatsApp message when receipt bookkeeping is retried', async () => {
    const c = createConversation(company.id, '923000000000', 'whatsapp', new Date().toISOString());
    c.version = 1;
    c.messages = [
      { id: 'local-reply', role: 'assistant', text: 'Test reply', createdAt: c.updatedAt },
    ];
    await repo.saveConversation(c, 0);
    await repo.saveIntegration(
      company.id,
      {
        kind: 'whatsapp',
        configured: true,
        status: 'connected',
        config: { phoneNumberId: '111', wabaId: '222' },
      },
      encryptSecret('test-token'),
    );
    vi.mocked(fetch).mockResolvedValue(Response.json({ messages: [{ id: 'wamid-retry' }] }));
    const job = makeJob(company.id, 'whatsapp_send', {
      conversationId: c.id,
      messageId: 'local-reply',
      text: 'Test reply',
      source: 'staff',
    });
    await repo.insertJob(job);
    vi.spyOn(repo, 'recordDelivery').mockRejectedValueOnce(Error('Transient database failure'));
    await expect(processJob(repo, job.id)).rejects.toThrow('waiting to retry');
    const retry = (await repo.getJob(job.id))!;
    expect(retry.payload.externalId).toBe('wamid-retry');
    await repo.saveJob({ ...retry, nextRunAt: new Date(0).toISOString() });
    await processJob(repo, job.id);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await repo.getJob(job.id))?.status).toBe('done');
    expect((await repo.getConversation(company.id, c.id))?.messages[0].delivery).toBe('accepted');
  });
  it('keeps sandbox ordering available while paused and never queues Sheet or WhatsApp delivery', async () => {
    await repo.saveCompany({
      ...company,
      botEnabled: false,
      ai: { ...company.ai, provider: 'gemini', model: 'gemini-2.5-flash-lite' },
    });
    await repo.saveIntegration(
      company.id,
      { kind: 'sheets', configured: true, status: 'connected', config: {} },
      encryptSecret('unused'),
    );
    let id: string | undefined;
    let result: TurnResult;
    for (const action of [
      { type: 'add_item', productId: seedProducts[0].id, quantity: 1 },
      { type: 'set_details', customerName: 'Sandbox Customer', fulfillment: 'pickup' },
      { type: 'review' },
      { type: 'confirm' },
    ] as BotAction[]) {
      const response = await request('/chat', {
        conversationId: id,
        messageId: randomUUID(),
        text: action.type === 'confirm' ? 'confirm' : 'test',
        action,
      });
      result = await response.json();
      expect(response.status, JSON.stringify(result)).toBe(200);
      id = result.conversation.id;
    }
    expect(result!.order).toMatchObject({
      sandbox: true,
      status: 'pending',
      syncStatus: 'not_connected',
    });
    expect(await repo.listCompanyJobs(company.id)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    const oldJob = makeJob(company.id, 'sheet_sync', { orderId: result!.order!.id });
    await repo.insertJob(oldJob);
    await processJob(repo, oldJob.id);
    expect((await repo.getJob(oldJob.id))?.status).toBe('done');
    expect(fetch).not.toHaveBeenCalled();
    const cancel = await request('/chat', {
      conversationId: id,
      messageId: randomUUID(),
      text: 'cancel order',
    });
    expect(cancel.status).toBe(200);
    expect((await cancel.json()).order.status).toBe('cancelled');
  });
  it('saves drafts with a revision guard and publishes or restores without enabling automation', async () => {
    await repo.saveCompany({ ...company, botEnabled: false });
    const config = {
      ...defaultBot,
      name: 'Laziza assistant',
      personality: 'concise',
      knowledge: [{ question: 'Parking', answer: 'Parking is available at the front.' }],
    };
    expect((await request('/bot/draft', { config, revision: 0 }, 'PUT')).status).toBe(200);
    expect((await request('/bot/draft', { config, revision: 0 }, 'PUT')).status).toBe(409);
    expect((await request('/bot/publish', { revision: 1 })).status).toBe(200);
    let saved = (await repo.getCompany(company.id))!;
    expect(saved.bot?.published?.config.name).toBe('Laziza assistant');
    expect(saved.botEnabled).toBe(false);
    expect(
      (await request('/bot/draft', { config: { ...config, name: 'Second' }, revision: 2 }, 'PUT'))
        .status,
    ).toBe(200);
    expect((await request('/bot/publish', { revision: 3 })).status).toBe(200);
    expect((await request('/bot/publish', { revision: 4, restoreVersion: 1 })).status).toBe(200);
    saved = (await repo.getCompany(company.id))!;
    expect(saved.bot?.published?.version).toBe(3);
    expect(saved.bot?.published?.config.name).toBe('Laziza assistant');
  });
  it('uses the draft collection sequence and greeting in sandbox only', async () => {
    const draft = {
      ...defaultBot,
      greeting: 'Welcome to our test kitchen.',
      steps: ['name', 'items', 'fulfillment', 'address'] as typeof defaultBot.steps,
    };
    await request('/bot/draft', { config: draft, revision: 0 }, 'PUT');
    const response = await request('/chat', { messageId: randomUUID(), text: 'hello' });
    const r = await response.json();
    expect(r.reply).toContain('Welcome to our test kitchen.');
    expect(r.reply.toLowerCase()).toContain('name');
    expect((await repo.getCompany(company.id))?.bot?.published).toBeUndefined();
  });
  it('rejects a WhatsApp number outside the token’s WABA without replacing a saved mapping', async () => {
    const old = {
      kind: 'whatsapp' as const,
      configured: true,
      status: 'connected' as const,
      config: { phoneNumberId: '111', wabaId: '222' },
    };
    await repo.saveIntegration(company.id, old, encryptSecret('old-token'));
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ data: [{ id: '777' }] }));
    expect(
      (
        await request('/integrations/whatsapp', {
          config: { phoneNumberId: '333', wabaId: '444' },
          secret: 'new-token',
        })
      ).status,
    ).toBe(403);
    expect((await repo.getIntegrations(company.id))[0]).toEqual(old);
  });
  it('does not persist WhatsApp credentials when the external subscription fails', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json({ data: [{ id: '333' }] }))
      .mockResolvedValueOnce(Response.json({ id: '333' }))
      .mockResolvedValueOnce(Response.json({ error: 'sensitive response' }, { status: 500 }));
    const response = await request('/integrations/whatsapp', {
      config: { phoneNumberId: '333', wabaId: '444' },
      secret: 'new-token',
    });
    expect(response.status).toBe(502);
    expect(await repo.getSecret(company.id, 'whatsapp')).toBeUndefined();
    expect(await response.text()).not.toContain('sensitive');
  });
  it('disconnects locally, removes the secret and pauses automation', async () => {
    await repo.saveIntegration(
      company.id,
      { kind: 'gemini', configured: true, status: 'connected', config: {} },
      encryptSecret('private-key'),
    );
    expect((await request('/integrations/gemini', undefined, 'DELETE')).status).toBe(200);
    expect(await repo.getSecret(company.id, 'gemini')).toBeUndefined();
    expect((await repo.getCompany(company.id))?.botEnabled).toBe(false);
  });
  it('paginates results and keeps a requested company slug scoped', async () => {
    const r = await (await request('/orders?page=1&pageSize=1')).json();
    expect(r.items).toHaveLength(1);
    expect(r.total).toBeGreaterThan(1);
    const first = r.items[0].id;
    const second = await (await request('/orders?page=2&pageSize=1')).json();
    expect(second.items[0].id).not.toBe(first);
    expect((await request('/bootstrap?companySlug=not-accessible')).status).toBe(403);
  });
  it('requires pausing before customer deletion and preserves other companies', async () => {
    const c = (await repo.listConversations(company.id))[0];
    const foreign = await repo.listConversations(seedCompanies[1].id);
    expect(
      (
        await request('/privacy/erase', {
          phone: c.customerPhone,
          externalCopiesAcknowledged: true,
        })
      ).status,
    ).toBe(409);
    await repo.saveCompany({ ...company, botEnabled: false });
    expect(
      (
        await request('/privacy/erase', {
          phone: c.customerPhone,
          externalCopiesAcknowledged: true,
        })
      ).status,
    ).toBe(200);
    expect(await repo.getConversation(company.id, c.id)).toBeUndefined();
    expect(await repo.listConversations(seedCompanies[1].id)).toEqual(foreign);
  });
  it('discovers paginated Gemini models while leaving new prices unapproved', async () => {
    const c = {
      ...company,
      ai: {
        ...company.ai,
        provider: 'gemini' as const,
        keyMode: 'own' as const,
        model: 'gemini-2.5-flash-lite',
      },
    };
    await repo.saveIntegration(
      c.id,
      { kind: 'gemini', configured: true, status: 'configured', config: {} },
      encryptSecret('catalog-specific-key'),
    );
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        Response.json({
          models: [
            {
              name: 'models/gemini-2.5-flash-lite',
              supportedGenerationMethods: ['generateContent'],
            },
          ],
          nextPageToken: 'next',
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          models: [
            { name: 'models/future-gemini', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/embed', supportedGenerationMethods: ['embedContent'] },
          ],
        }),
      );
    const catalog = await availableModels(repo, c, true);
    expect(catalog.items).toHaveLength(2);
    expect(catalog.items.find((m) => m.id === 'future-gemini')?.priced).toBe(false);
    expect(String(vi.mocked(fetch).mock.calls[1][0])).toContain('pageToken=next');
    expect(c.ai.model).toBe('gemini-2.5-flash-lite');
  });
  it('serializes rate allowance and rejects an unsafe bot flow', async () => {
    expect(await repo.consumeRateLimit('sample', 1)).toBe(true);
    expect(await repo.consumeRateLimit('sample', 1)).toBe(false);
    expect(
      (
        await request(
          '/bot/draft',
          { config: { ...defaultBot, steps: ['items', 'items', 'name', 'address'] }, revision: 0 },
          'PUT',
        )
      ).status,
    ).toBe(400);
  });
  it('maps deep links without accepting arbitrary routes', () => {
    expect(parseRoute(workspacePath('laziza-foods', 'orders', 'order-123'))).toEqual({
      slug: 'laziza-foods',
      page: 'orders',
      id: 'order-123',
      valid: true,
    });
    expect(parseRoute('/app/laziza-foods/not-a-page').valid).toBe(false);
    expect(parseRoute('/whatever/privacy').valid).toBe(false);
  });
});
