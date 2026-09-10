import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app';
import { MemoryRepository, DemoFileRepository } from '../server/repository';
import { encryptSecret, decryptSecret, verifyMetaSignature } from '../server/security';
import { makeJob } from '../server/jobs';
import { handleTurn, processJob } from '../server/service';
import { WhatsAppAdapter } from '../server/integrations/whatsapp';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import { createConversation, processTurn } from '../src/domain/engine';
import { catalogFromRows, parseCsv } from '../server/integrations/catalog';
import type { BotAction, Conversation, TurnResult } from '../src/shared/types';

vi.mock('@vercel/queue', () => ({ send: vi.fn(async () => ({ messageId: 'fake-queue-id' })) }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'signed-in-user' } }, error: null }) },
  }),
}));
const company = seedCompanies[0];
const other = seedCompanies[1];
let repo: MemoryRepository;
beforeEach(() => {
  repo = new MemoryRepository();
  vi.stubEnv('APP_MODE', 'demo');
  vi.stubEnv('VERCEL', '');
  vi.stubEnv('APP_URL', 'http://127.0.0.1:5173');
  vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  vi.stubEnv('META_APP_SECRET', 'test-app-secret');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
async function request(
  path: string,
  body?: unknown,
  companyId = company.id,
  method = body === undefined ? 'GET' : 'POST',
) {
  return createApp(repo).request(`http://127.0.0.1:4000/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-company-id': companyId,
      Origin: 'http://127.0.0.1:5173',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function pendingOrder(channel: Conversation['channel'] = 'demo') {
  let conversation = createConversation(
    company.id,
    '923001234567',
    channel,
    new Date().toISOString(),
  );
  const turn = (action: BotAction) => {
    const result = processTurn(
      company,
      seedProducts.filter((p) => p.companyId === company.id),
      conversation,
      {
        messageId: randomUUID(),
        text: action.type === 'confirm' ? 'confirm' : 'test',
        action,
        now: new Date().toISOString(),
      },
    );
    conversation = result.conversation;
    return result;
  };
  turn({ type: 'add_item', productId: seedProducts[0].id, quantity: 2 });
  turn({ type: 'set_details', customerName: 'Cancel Test', fulfillment: 'pickup' });
  turn({ type: 'review' });
  const result = turn({ type: 'confirm' });
  if (!result.order) throw new Error(result.reply);
  conversation.version = 1;
  await repo.commitTurn(company.id, conversation, 0, result.order);
  return { conversation, order: result.order };
}
describe('HTTP and service behavior', () => {
  it('runs a complete order, prevents replay, and keeps it inside its company', async () => {
    let id: string | undefined;
    const before = (await repo.listOrders(company.id)).length;
    const turn = async (action: BotAction, text = 'test', messageId = randomUUID()) => {
      const response = await request('/chat', { conversationId: id, messageId, text, action });
      const result = (await response.json()) as TurnResult;
      expect(response.status, JSON.stringify(result)).toBe(200);
      id = result.conversation.id;
      return result;
    };
    await turn({ type: 'add_item', productId: seedProducts[0].id, quantity: 2 });
    await turn({ type: 'set_details', customerName: 'API Test', fulfillment: 'pickup' });
    await turn({ type: 'review' });
    const messageId = randomUUID();
    const placed = await turn({ type: 'confirm' }, 'confirm', messageId);
    expect(placed.order?.total).toBe(90000);
    expect(placed.order?.status).toBe('pending');
    await turn({ type: 'confirm' }, 'confirm', messageId);
    expect((await repo.listOrders(company.id)).length).toBe(before + 1);
    expect(await repo.getOrder(other.id, placed.order!.id)).toBeUndefined();
    expect(
      (await request(`/orders/${placed.order!.id}/status`, { status: 'accepted' }, other.id))
        .status,
    ).toBe(404);
    expect(
      (await request(`/orders/${placed.order!.id}/status`, { status: 'accepted' })).status,
    ).toBe(200);
    expect(
      (await request(`/orders/${placed.order!.id}/status`, { status: 'completed' })).status,
    ).toBe(400);
  });
  it('rejects a foreign conversation and does not trust caller-supplied tenant fields', async () => {
    const foreign = (await repo.listConversations(other.id))[0];
    expect(
      (await request('/chat', { conversationId: foreign.id, text: 'menu', messageId: 'x' })).status,
    ).toBe(404);
    const foreignProduct = seedProducts.find((p) => p.companyId === other.id)!;
    expect((await request('/products', foreignProduct)).status).toBe(404);
    expect((await repo.listProducts(other.id)).find((p) => p.id === foreignProduct.id)).toEqual(
      foreignProduct,
    );
  });
  it('does not expose saved credentials in bootstrap', async () => {
    const secret = 'a-test-api-key';
    expect((await request('/integrations/openai', { config: {}, secret })).status).toBe(200);
    const body = await (await request('/bootstrap')).text();
    expect(body).not.toContain(secret);
    expect(body).not.toContain(await repo.getSecret(company.id, 'openai'));
    expect(decryptSecret((await repo.getSecret(company.id, 'openai'))!)).toBe(secret);
  });
  it('rejects cross-site requests and unauthenticated live access', async () => {
    expect(
      (
        await createApp(repo).request('http://127.0.0.1/api/bootstrap', {
          headers: { Origin: 'https://attacker.example' },
        })
      ).status,
    ).toBe(403);
    vi.stubEnv('APP_MODE', 'live');
    expect((await request('/bootstrap')).status).toBe(401);
  });
  it('enforces staff permissions and company membership for authenticated requests', async () => {
    vi.stubEnv('APP_MODE', 'live');
    vi.spyOn(repo, 'getRole').mockImplementation(async (_user, id) =>
      id === company.id ? 'staff' : null,
    );
    const app = createApp(repo);
    const headers = {
      Authorization: 'Bearer test-session',
      'x-company-id': company.id,
      'Content-Type': 'application/json',
    };
    expect((await app.request('http://localhost/api/bootstrap', { headers })).status).toBe(200);
    expect(
      (
        await app.request('http://localhost/api/bootstrap', {
          headers: { ...headers, 'x-company-id': other.id },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request('http://localhost/api/products', {
          method: 'POST',
          headers,
          body: JSON.stringify(seedProducts[0]),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request('http://localhost/api/integrations/openai', {
          method: 'POST',
          headers,
          body: JSON.stringify({ config: {}, secret: 'key' }),
        })
      ).status,
    ).toBe(403);
  });
  it('prevents restaurant owners from increasing their platform spending allowance', async () => {
    vi.stubEnv('APP_MODE', 'live');
    vi.spyOn(repo, 'getRole').mockImplementation(async (_user, id) =>
      id === company.id ? 'owner' : null,
    );
    const response = await createApp(repo).request(`http://localhost/api/companies/${company.id}`, {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer test-session',
        'x-company-id': company.id,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ...company, ai: { ...company.ai, monthlyBudgetUsd: 1000 } }),
    });
    expect(response.status).toBe(403);
  });
  it('creates an empty isolated business with automation paused', async () => {
    const response = await request('/companies', { name: 'A new restaurant' });
    expect(response.status).toBe(201);
    const created = await response.json();
    const bootstrap = await (await request('/bootstrap', undefined, created.id)).json();
    expect(bootstrap.company.botEnabled).toBe(false);
    expect(bootstrap.products).toHaveLength(0);
    expect(bootstrap.orders).toHaveLength(0);
    expect(bootstrap.conversations).toHaveLength(0);
  });
  it('verifies Meta signatures and deduplicates repeated webhook deliveries', async () => {
    vi.stubEnv('APP_MODE', 'live');
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
    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '123' },
                messages: [
                  {
                    id: 'wamid.123',
                    from: '923001111111',
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    text: { body: 'menu' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const signature = `sha256=${createHmac('sha256', 'test-app-secret').update(body).digest('hex')}`;
    const app = createApp(repo);
    expect(
      (
        await app.request('http://127.0.0.1/api/webhooks/whatsapp', {
          method: 'POST',
          body,
          headers: { 'x-hub-signature-256': 'sha256=bad' },
        })
      ).status,
    ).toBe(401);
    for (let i = 0; i < 2; i++)
      expect(
        (
          await app.request('http://127.0.0.1/api/webhooks/whatsapp', {
            method: 'POST',
            body,
            headers: { 'x-hub-signature-256': signature },
          })
        ).status,
      ).toBe(200);
    expect(await repo.listDueJobs(100)).toHaveLength(1);
  });
  it('mobile staff echoes pause automation and never create an outgoing reply', async () => {
    const conversation = createConversation(
      company.id,
      '923001111111',
      'whatsapp',
      new Date().toISOString(),
    );
    conversation.version = 1;
    await repo.saveConversation(conversation, 0);
    const job = makeJob(company.id, 'incoming', {
      phone: conversation.customerPhone,
      messageId: 'mobile-1',
      text: 'I will help you.',
      echo: true,
    });
    await repo.insertJob(job);
    await processJob(repo, job.id);
    const saved = await repo.getConversation(company.id, conversation.id);
    expect(saved?.mode).toBe('human');
    expect(saved?.messages.at(-1)?.role).toBe('staff');
    expect(saved?.lastInboundAt).toBe(conversation.lastInboundAt);
    expect(await repo.listDueJobs(100)).toHaveLength(0);
    await processJob(repo, job.id);
    expect((await repo.getConversation(company.id, conversation.id))?.messages).toHaveLength(1);
  });
  it.each(['human takeover', 'company pause'])(
    'respects %s for customer cancellation',
    async (reason) => {
      const { conversation, order } = await pendingOrder();
      if (reason === 'human takeover') {
        await repo.saveConversation({ ...conversation, mode: 'human', version: 2 }, 1);
      } else {
        await repo.saveCompany({ ...company, botEnabled: false });
      }
      // Supply the old snapshot to exercise the service's fresh state checks.
      const result = await handleTurn(repo, company, conversation, {
        messageId: 'cancel-paused',
        text: 'cancel order',
        now: new Date().toISOString(),
      });
      expect(result.reply).toBe('');
      expect((await repo.getOrder(company.id, order.id))?.status).toBe('pending');
      expect(result.conversation.messages.at(-1)?.id).toBe('cancel-paused');
      expect(await repo.listDueJobs(100)).toHaveLength(0);
    },
  );
  it('commits customer cancellation together with its conversation', async () => {
    const { conversation, order } = await pendingOrder();
    const result = await handleTurn(repo, company, conversation, {
      messageId: 'cancel-1',
      text: 'cancel order',
      now: new Date().toISOString(),
    });
    expect(result.order?.status).toBe('cancelled');
    const saved = await repo.getConversation(company.id, conversation.id);
    expect(saved?.cart.status).toBe('cancelled');
    expect(saved?.version).toBe(2);
    expect(saved?.messages.at(-1)?.text).toBe(result.reply);
    expect((await repo.getOrder(company.id, order.id))?.status).toBe('cancelled');
  });
  it('does not cancel if staff takes over during the cancellation transaction', async () => {
    const { conversation, order } = await pendingOrder();
    const update = repo.updateOrderStatus.bind(repo);
    vi.spyOn(repo, 'updateOrderStatus').mockImplementation(async (...args) => {
      await repo.saveConversation({ ...conversation, mode: 'human', version: 2 }, 1);
      return update(...args);
    });
    await expect(
      handleTurn(repo, company, conversation, {
        messageId: 'cancel-race',
        text: 'cancel',
        now: new Date().toISOString(),
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await repo.getOrder(company.id, order.id))?.status).toBe('pending');
    expect((await repo.getConversation(company.id, conversation.id))?.mode).toBe('human');
    expect(await repo.listDueJobs(100)).toHaveLength(0);
  });
  it('sends the handoff acknowledgement after the bot yields to staff', async () => {
    await repo.saveIntegration(
      company.id,
      {
        kind: 'whatsapp',
        configured: true,
        status: 'configured',
        config: { phoneNumberId: '123' },
      },
      encryptSecret('test-token'),
    );
    const send = vi.spyOn(WhatsAppAdapter.prototype, 'send').mockResolvedValue('mock-meta-id');
    const conversation = createConversation(
      company.id,
      '923001234500',
      'whatsapp',
      new Date().toISOString(),
    );
    const result = await handleTurn(repo, company, conversation, {
      messageId: 'handoff-1',
      text: 'staff',
      now: new Date().toISOString(),
    });
    expect(result.conversation.mode).toBe('human');
    const [job] = await repo.listDueJobs(100);
    expect(job.payload.source).toBe('notice');
    await processJob(repo, job.id);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][1]).toBe(result.reply);
    expect((await repo.getJob(job.id))?.status).toBe('done');
  });
  it('suppresses already queued automatic replies when the company pauses its bot', async () => {
    const { conversation } = await pendingOrder('whatsapp');
    const job = makeJob(company.id, 'whatsapp_send', {
      conversationId: conversation.id,
      text: 'Old bot reply',
      source: 'bot',
    });
    await repo.insertJob(job);
    await repo.saveCompany({ ...company, botEnabled: false });
    const send = vi.spyOn(WhatsAppAdapter.prototype, 'send').mockResolvedValue('should-not-send');
    await processJob(repo, job.id);
    expect(send).not.toHaveBeenCalled();
    expect((await repo.getJob(job.id))?.status).toBe('done');
  });
  it('does not let a queued confirmation overtake an earlier cart edit', async () => {
    const { conversation, order } = await pendingOrder('whatsapp');
    const reviewed = {
      ...conversation,
      version: 2,
      cart: { ...conversation.cart, status: 'awaiting_confirmation' as const, orderId: undefined },
    };
    await repo.saveConversation(reviewed, 1);
    const count = (await repo.listOrders(company.id)).length;
    const edit = makeJob(company.id, 'incoming', {
      phone: conversation.customerPhone,
      messageId: 'edit-before-confirm',
      text: 'change to one',
      action: { type: 'add_item', productId: seedProducts[0].id, quantity: 1 },
    });
    const confirm = makeJob(company.id, 'incoming', {
      phone: conversation.customerPhone,
      messageId: 'later-confirm',
      text: 'confirm',
    });
    await repo.insertJob(edit);
    await repo.insertJob(confirm);
    await processJob(repo, confirm.id);
    expect((await repo.getJob(confirm.id))?.status).toBe('pending');
    expect(
      (await repo.getConversation(company.id, conversation.id))?.messages.some(
        (m) => m.id === 'later-confirm',
      ),
    ).toBe(false);
    await processJob(repo, edit.id);
    await processJob(repo, confirm.id);
    expect((await repo.listOrders(company.id)).length).toBe(count);
    expect((await repo.getJob(confirm.id))?.status).toBe('done');
    expect((await repo.getOrder(company.id, order.id))?.status).toBe('pending');
    expect((await repo.getConversation(company.id, conversation.id))?.cart.status).toBe(
      'awaiting_confirmation',
    );
  });
  it('marks a permanently failed incoming conversation for staff before recovery', async () => {
    const { conversation } = await pendingOrder('whatsapp');
    const job = {
      ...makeJob(company.id, 'incoming', {
        phone: conversation.customerPhone,
        messageId: 'failed-inbound',
        text: 'menu',
      }),
      attempts: 4,
    };
    await repo.insertJob(job);
    vi.spyOn(repo, 'commitTurn').mockRejectedValueOnce(new Error('Database unavailable'));
    await processJob(repo, job.id);
    expect((await repo.getJob(job.id))?.status).toBe('failed');
    expect((await repo.getConversation(company.id, conversation.id))?.mode).toBe('human');
    expect(await repo.listTraces(company.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'job.failed', conversationId: conversation.id }),
      ]),
    );
    await repo.retryFailedJobs(company.id);
    await processJob(repo, job.id);
    expect((await repo.getJob(job.id))?.status).toBe('done');
    expect(
      (await repo.getConversation(company.id, conversation.id))?.messages.at(-1),
    ).toMatchObject({ id: 'failed-inbound', role: 'customer' });
    expect(await repo.listDueJobs(100)).toHaveLength(0);
  });
  it('blocks sending a simulated conversation through the real WhatsApp adapter', async () => {
    const { WhatsAppAdapter } = await import('../server/integrations/whatsapp');
    const adapter = new WhatsAppAdapter(
      { kind: 'whatsapp', configured: true, status: 'configured', config: {} },
      'token',
    );
    const conversation = createConversation(company.id, 'demo', 'demo', new Date().toISOString());
    await expect(adapter.send(conversation, 'hi')).rejects.toThrow('Test conversations');
    await expect(adapter.sendStatusTemplate(conversation, 'order', 'accepted')).rejects.toThrow(
      'Test conversations',
    );
  });
  it('persists changes across a local store restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orderly-test-'));
    try {
      const path = join(dir, 'data.json');
      const a = new DemoFileRepository(path);
      await a.saveCompany({ ...company, name: 'Persisted test' });
      const b = new DemoFileRepository(path);
      expect((await b.getCompany(company.id))?.name).toBe('Persisted test');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
describe('credentials and imports', () => {
  it('encrypts with unique nonces and rejects tampering', () => {
    const a = encryptSecret('secret');
    expect(a).not.toBe(encryptSecret('secret'));
    expect(decryptSecret(a)).toBe('secret');
    const parts = a.split('.');
    parts[2] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptSecret(parts.join('.'))).toThrow();
    expect(verifyMetaSignature('body', 'sha256=bad')).toBe(false);
  });
  it('parses quoted CSV and converts rupee prices to minor units', () => {
    const rows = parseCsv(
      'id,name,description,category,price,available\nbiryani,Chicken Biryani,"Rice, chicken",Mains,450.50,true',
    );
    const products = catalogFromRows(company.id, rows);
    expect(products[0].price).toBe(45050);
    expect(products[0].description).toBe('Rice, chicken');
    expect(catalogFromRows(company.id, rows)[0].id).toBe(products[0].id);
    expect(catalogFromRows(other.id, rows)[0].id).not.toBe(products[0].id);
  });
  it('rejects invalid imports rather than partially replacing the menu', async () => {
    const before = await repo.listProducts(company.id);
    const response = await request('/catalog/import', {
      csv: 'name,category,price,available\nBiryani,Mains,450,true\nBad,Mains,-1,true',
    });
    expect(response.status).toBe(400);
    expect(await repo.listProducts(company.id)).toEqual(before);
  });
});
