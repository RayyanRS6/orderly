import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { cors } from 'hono/cors';
import { createClient } from '@supabase/supabase-js';
import { z, ZodError } from 'zod';
import type { Repository } from './repository.js';
import type {
  BotAction,
  Company,
  Integration,
  IntegrationKind,
  Role,
  OrderStatus,
} from '../src/shared/types.js';
import { createConversation } from '../src/domain/engine.js';
import { appMode, env } from './config.js';
import {
  PublicError,
  encryptSecret,
  safeEqual,
  sanitizeError,
  verifyMetaSignature,
} from './security.js';
import { productSchema, companySchema, chatSchema } from './validation.js';
import { catalogFromRows, parseCsv } from './integrations/catalog.js';
import { modelDefaults, providerKey, validateModelConfiguration } from './integrations/models.js';
import {
  handleTurn,
  integrationAdapter,
  refreshCatalog,
  changeOrderStatus,
  processJob,
} from './service.js';
import { dispatchJob, makeJob, recoverJobs } from './jobs.js';
import { finishSignup, signupSchema } from './integrations/signup.js';

type Env = {
  Variables: { company: Company; role: Role; userId: string; allowedCompanies: Company[] };
};
const kindSchema = z.enum(['whatsapp', 'sheets', 'openai', 'anthropic', 'gemini']);
const integrationKeys: Record<IntegrationKind, string[]> = {
  whatsapp: ['phoneNumberId', 'wabaId', 'statusTemplate', 'templateLanguage'],
  sheets: ['spreadsheetId', 'catalogSheet', 'ordersSheet', 'clientEmail'],
  openai: ['model'],
  anthropic: ['model'],
  gemini: ['model'],
};
const owner = (role: Role) => {
  if (!['owner', 'admin'].includes(role))
    throw new PublicError('Only the restaurant owner can change these settings.', 403);
};

export type AppOptions = { waitUntil?: (task: Promise<unknown>) => void };

export function createApp(repo: Repository, options: AppOptions = {}) {
  const app = new Hono<Env>();
  app.use('/api/*', secureHeaders());
  app.use('/api/*', async (c, next) => {
    // The split frontend may access only this exact origin; webhooks and workers
    // authenticate separately and do not send browser Origin headers.
    const allowedOrigin =
      process.env.APP_URL ||
      (appMode() === 'demo' ? 'http://127.0.0.1:5173' : new URL(c.req.url).origin);
    const origin = c.req.header('origin');
    if (origin && origin !== allowedOrigin)
      throw new PublicError('This origin is not allowed.', 403);
    return cors({
      origin: allowedOrigin,
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'x-company-id'],
      maxAge: 3600,
    })(c, next);
  });
  app.use(
    '/api/*',
    bodyLimit({
      maxSize: 600000,
      onError: (c) => c.json({ error: 'Request exceeds 600 KB.' }, 413),
    }),
  );
  app.onError((error, c) => {
    if (error instanceof ZodError)
      return c.json(
        {
          error: error.issues
            .map((i) => `${i.path.join('.') || 'Request'}: ${i.message}`)
            .join('; '),
        },
        400,
      );
    return c.json(
      { error: sanitizeError(error) },
      (error instanceof PublicError ? error.status : 500) as 400,
    );
  });
  app.get('/api/config', (c) =>
    c.json({
      mode: appMode(),
      supabaseUrl: process.env.SUPABASE_URL || '',
      supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
    }),
  );
  app.get('/api/health', (c) => c.json({ ok: true, mode: appMode() }));
  app.post('/api/jobs/process', async (c) => {
    if (appMode() !== 'live') throw new PublicError('Hosted workers require live mode.', 503);
    const secret = process.env.CRON_SECRET;
    if (!secret || !safeEqual(c.req.header('authorization') || '', `Bearer ${secret}`))
      throw new PublicError('Unauthorized.', 401);
    const { jobId } = z
      .object({ jobId: z.string().min(1).max(200) })
      .strict()
      .parse(await c.req.json());
    const task = processJob(repo, jobId);
    if (options.waitUntil) {
      // Failures are saved by processJob; never log provider payloads or keys.
      options.waitUntil(task.catch(() => console.warn('Saved job awaits recovery.')));
      return c.json({ accepted: true }, 202);
    }
    await task;
    return c.json({ processed: true });
  });
  app.get('/api/webhooks/whatsapp', (c) => {
    const token = process.env.META_VERIFY_TOKEN;
    if (
      token &&
      c.req.query('hub.mode') === 'subscribe' &&
      safeEqual(c.req.query('hub.verify_token') || '', token)
    )
      return c.text(c.req.query('hub.challenge') || '');
    return c.json({ error: 'Webhook verification failed.' }, 403);
  });
  app.post('/api/webhooks/whatsapp', async (c) => {
    if (appMode() !== 'live')
      throw new PublicError('Live webhooks are disabled in local demo mode.', 503);
    const raw = await c.req.text();
    if (!verifyMetaSignature(raw, c.req.header('x-hub-signature-256')))
      throw new PublicError('Invalid webhook signature.', 401);
    const data = JSON.parse(raw);
    if (data.object !== 'whatsapp_business_account') return c.json({ received: true });
    const pending = [];
    for (const entry of data.entry ?? [])
      for (const change of entry.changes ?? []) {
        const value = change.value ?? {};
        const numberId = String(value.metadata?.phone_number_id ?? '');
        const company = await repo.findCompanyByPhoneNumberId(numberId);
        if (!company) continue;
        for (const status of value.statuses ?? [])
          await repo.addTrace({
            id: randomUUID(),
            companyId: company.id,
            action: `whatsapp.${String(status.status).slice(0, 30)}`,
            detail: `Meta message ${String(status.id).slice(0, 150)}`,
            createdAt: new Date().toISOString(),
          });
        if (change.field === 'smb_message_echoes') {
          for (const echo of value.message_echoes ?? []) {
            if (typeof echo.id !== 'string' || typeof echo.to !== 'string') continue;
            const text = String(
              echo.text?.body ??
                (echo.type === 'edit'
                  ? `Staff edited a message: ${echo.edit?.message?.text?.body ?? '[media]'}`
                  : echo.type === 'revoke'
                    ? 'Staff deleted a message in WhatsApp.'
                    : `Staff sent a ${echo.type || 'media'} message in WhatsApp.`),
            ).slice(0, 2000);
            const job = makeJob(company.id, 'incoming', {
              phone: echo.to,
              messageId: echo.id,
              text,
              echo: true,
            });
            if (await repo.insertJob(job, `${numberId}:echo:${echo.id}`)) pending.push(job);
          }
          continue;
        }
        for (const message of value.messages ?? []) {
          if (typeof message.id !== 'string' || typeof message.from !== 'string') continue;
          let text = String(
            message.text?.body ??
              message.interactive?.button_reply?.title ??
              message.interactive?.list_reply?.title ??
              '',
          ).slice(0, 2000);
          const button = String(
            message.interactive?.button_reply?.id ?? message.interactive?.list_reply?.id ?? '',
          );
          let action: BotAction | undefined;
          if (/^confirm:\d+$/.test(button))
            action = { type: 'confirm', revision: Number(button.split(':')[1]) };
          if (['menu', 'review', 'handoff', 'new_order'].includes(button))
            action = { type: button } as BotAction;
          if (!text && !action) {
            text = 'Customer sent a media message. Staff assistance requested.';
            action = { type: 'handoff' };
          }
          const job = makeJob(company.id, 'incoming', {
            phone: message.from,
            messageId: message.id,
            text,
            action,
          });
          // Preserve the original message timestamp for WhatsApp's 24-hour window.
          if (/^\d+$/.test(String(message.timestamp)))
            job.createdAt = new Date(Number(message.timestamp) * 1000).toISOString();
          if (await repo.insertJob(job, `${numberId}:${message.id}`)) pending.push(job);
        }
      }
    for (const job of pending) await dispatchJob(repo, job);
    return c.json({ received: true });
  });
  app.get('/api/cron/recover', async (c) => {
    const secret = process.env.CRON_SECRET;
    if (!secret || !safeEqual(c.req.header('authorization') || '', `Bearer ${secret}`))
      throw new PublicError('Unauthorized.', 401);
    const dispatched = await recoverJobs(repo);
    // Catalogs are refreshed by handleTurn before use and by the owner's sync
    // action, avoiding an unbounded sweep of idle restaurants here.
    return c.json({ dispatched });
  });
  app.use('/api/*', async (c, next) => {
    const mode = appMode();
    let allowed: Company[];
    let userId = 'local-demo-admin';
    if (mode === 'demo') {
      const hostname = new URL(c.req.url).hostname;
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname))
        throw new PublicError('Demo access is restricted to this computer.', 403);
      allowed = await repo.listCompanies();
    } else {
      const bearer = c.req.header('authorization')?.match(/^Bearer (.+)$/)?.[1];
      if (!bearer) throw new PublicError('Sign in to continue.', 401);
      const client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data, error } = await client.auth.getUser(bearer);
      if (error || !data.user) throw new PublicError('Your session expired. Sign in again.', 401);
      userId = data.user.id;
      const all = await repo.listCompanies();
      allowed = (await repo.isAdmin(userId))
        ? all
        : (
            await Promise.all(
              all.map(async (company) =>
                (await repo.getRole(userId, company.id)) ? company : null,
              ),
            )
          ).filter((x): x is Company => !!x);
    }
    c.set('userId', userId);
    c.set('allowedCompanies', allowed);
    const companyId = c.req.query('companyId') || c.req.header('x-company-id') || allowed[0]?.id;
    const company = allowed.find((x) => x.id === companyId);
    // The first platform administrator may create a business in an empty live database.
    if (!company) {
      if (c.req.path === '/api/account' && c.req.method === 'GET') return next();
      if (
        c.req.path === '/api/companies' &&
        c.req.method === 'POST' &&
        (mode === 'demo' || (await repo.isAdmin(userId)))
      ) {
        c.set('role', 'admin');
        return next();
      }
      throw new PublicError(
        'No accessible company found. Ask the platform administrator to add your membership.',
        403,
      );
    }
    const role = mode === 'demo' ? 'admin' : await repo.getRole(userId, company.id);
    if (!role) throw new PublicError('Your company membership is no longer active.', 403);
    c.set('company', company);
    c.set('role', role);
    await next();
  });
  app.get('/api/account', async (c) =>
    c.json({
      isAdmin: appMode() === 'demo' || (await repo.isAdmin(c.get('userId'))),
      companyCount: c.get('allowedCompanies').length,
    }),
  );
  app.get('/api/bootstrap', async (c) => {
    const company = c.get('company');
    const [products, orders, conversations, integrations, usage, traces] = await Promise.all([
      repo.listProducts(company.id),
      repo.listOrders(company.id),
      repo.listConversations(company.id),
      repo.getIntegrations(company.id),
      repo.listUsage(company.id),
      repo.listTraces(company.id),
    ]);
    const allIntegrations = kindSchema.options.map(
      (kind) =>
        integrations.find((i) => i.kind === kind) ?? {
          kind,
          configured: false,
          status: 'disconnected',
          config: {},
        },
    );
    let aiKeyConfigured = company.ai.provider === 'mock';
    if (!aiKeyConfigured) {
      try {
        await providerKey(repo, company);
        aiKeyConfigured = true;
      } catch {
        // Readiness exposes only availability, never credentials or decryption errors.
      }
    }
    return c.json({
      mode: appMode(),
      role: c.get('role'),
      company,
      companies: c.get('allowedCompanies'),
      products,
      orders,
      conversations,
      integrations: allIntegrations,
      aiConnection: {
        provider: company.ai.provider,
        keyMode: company.ai.keyMode,
        configured: aiKeyConfigured,
      },
      usage,
      traces,
    });
  });
  app.post('/api/companies', async (c) => {
    if (c.get('role') !== 'admin')
      throw new PublicError('Only the platform administrator can create companies.', 403);
    const body = z
      .object({
        name: z.string().trim().min(1).max(120),
        address: z.string().max(500).default(''),
        phone: z.string().max(40).default(''),
      })
      .parse(await c.req.json());
    const id = randomUUID();
    const company: Company = {
      ...body,
      id,
      slug: `${body.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .slice(0, 70)}-${id.slice(0, 6)}`,
      timezone: 'Asia/Karachi',
      currency: 'PKR',
      botEnabled: false,
      catalogSource: 'app',
      openingHours: { start: '11:00', end: '23:00', days: [0, 1, 2, 3, 4, 5, 6] },
      deliveryZones: [],
      faqs: [],
      ai: {
        provider: 'mock',
        model: modelDefaults.mock,
        keyMode: 'platform',
        monthlyBudgetUsd: 10,
      },
      createdAt: new Date().toISOString(),
    };
    await repo.saveCompany(company);
    return c.json(company, 201);
  });
  app.put('/api/companies/:id', async (c) => {
    owner(c.get('role'));
    if (c.req.param('id') !== c.get('company').id) throw new PublicError('Company not found.', 404);
    const body = companySchema.parse(await c.req.json());
    const company = {
      ...c.get('company'),
      ...body,
      id: c.get('company').id,
      createdAt: c.get('company').createdAt,
    };
    if (
      c.get('role') !== 'admin' &&
      company.ai.monthlyBudgetUsd > c.get('company').ai.monthlyBudgetUsd
    )
      throw new PublicError('Ask the platform administrator to raise your AI budget.', 403);
    if (
      c.get('role') !== 'admin' &&
      company.ai.keyMode === 'platform' &&
      c.get('company').ai.keyMode !== 'platform'
    )
      throw new PublicError(
        'The platform administrator must enable use of platform API keys.',
        403,
      );
    validateModelConfiguration(company);
    if (appMode() === 'live' && company.botEnabled && company.ai.provider === 'mock')
      throw new PublicError('Select a live model before enabling WhatsApp automation.');
    await repo.saveCompany(company);
    return c.json(company);
  });
  app.post('/api/products', async (c) => {
    owner(c.get('role'));
    if (c.get('company').catalogSource === 'sheets')
      throw new PublicError(
        'Edit the connected menu Sheet, or switch the catalog source to the app.',
      );
    const body = productSchema.parse(await c.req.json());
    const product = { ...body, id: body.id || randomUUID(), companyId: c.get('company').id };
    const existing = await repo.listProducts(product.companyId);
    if (body.id && !existing.some((p) => p.id === body.id))
      throw new PublicError('Menu item not found.', 404);
    await repo.saveProduct(product);
    return c.json(product);
  });
  app.delete('/api/products/:id', async (c) => {
    owner(c.get('role'));
    if (c.get('company').catalogSource === 'sheets')
      throw new PublicError('Edit the connected menu Sheet.');
    await repo.deleteProduct(c.get('company').id, c.req.param('id'));
    return c.json({ ok: true });
  });
  app.post('/api/catalog/import', async (c) => {
    owner(c.get('role'));
    if (c.get('company').catalogSource !== 'app')
      throw new PublicError('Switch the catalog source to the app before importing CSV.');
    const { csv } = z.object({ csv: z.string().max(500000) }).parse(await c.req.json());
    const products = catalogFromRows(c.get('company').id, parseCsv(csv));
    await repo.replaceProducts(c.get('company').id, products);
    return c.json({ count: products.length });
  });
  app.post('/api/catalog/refresh', async (c) => {
    owner(c.get('role'));
    return c.json({ count: await refreshCatalog(repo, c.get('company')) });
  });
  app.post('/api/chat', async (c) => {
    const body = chatSchema.parse(await c.req.json());
    const company = c.get('company');
    let conversation = body.conversationId
      ? await repo.getConversation(company.id, body.conversationId)
      : undefined;
    if (body.conversationId && !conversation) throw new PublicError('Conversation not found.', 404);
    if (conversation?.channel === 'whatsapp')
      throw new PublicError('Use the staff inbox to reply to real customers.');
    conversation ??= createConversation(
      company.id,
      `demo-${randomUUID().slice(0, 8)}`,
      'demo',
      new Date().toISOString(),
    );
    return c.json(
      await handleTurn(repo, company, conversation, { ...body, now: new Date().toISOString() }),
    );
  });
  app.post('/api/orders/:id/status', async (c) => {
    const { status } = z
      .object({
        status: z.enum([
          'pending',
          'accepted',
          'preparing',
          'ready',
          'out_for_delivery',
          'completed',
          'rejected',
          'cancelled',
        ]),
      })
      .parse(await c.req.json());
    const order = await repo.getOrder(c.get('company').id, c.req.param('id'));
    if (!order) throw new PublicError('Order not found.', 404);
    let updated;
    try {
      updated = await changeOrderStatus(repo, order, status);
    } catch (error) {
      if (error instanceof PublicError) throw error;
      throw new PublicError(error instanceof Error ? error.message : 'Invalid order transition.');
    }
    const conversation = await repo.getConversation(order.companyId, order.conversationId);
    if (conversation) {
      const text = `Order ${order.reference} is now ${status.replaceAll('_', ' ')}.`;
      const next = {
        ...conversation,
        version: conversation.version + 1,
        updatedAt: new Date().toISOString(),
        messages: [
          ...conversation.messages,
          { id: randomUUID(), role: 'staff' as const, text, createdAt: new Date().toISOString() },
        ],
      };
      await repo.saveConversation(next, conversation.version);
    }
    return c.json(updated);
  });
  app.post('/api/conversations/:id/mode', async (c) => {
    const { mode } = z.object({ mode: z.enum(['bot', 'human']) }).parse(await c.req.json());
    const conversation = await repo.getConversation(c.get('company').id, c.req.param('id'));
    if (!conversation) throw new PublicError('Conversation not found.', 404);
    const next = {
      ...conversation,
      mode,
      version: conversation.version + 1,
      updatedAt: new Date().toISOString(),
    };
    if (!(await repo.saveConversation(next, conversation.version)))
      throw new PublicError('Conversation changed. Try again.', 409);
    return c.json(next);
  });
  app.post('/api/conversations/:id/reply', async (c) => {
    const { text } = z
      .object({ text: z.string().trim().min(1).max(2000) })
      .parse(await c.req.json());
    const conversation = await repo.getConversation(c.get('company').id, c.req.param('id'));
    if (!conversation) throw new PublicError('Conversation not found.', 404);
    if (
      conversation.channel === 'whatsapp' &&
      Date.now() - Date.parse(conversation.lastInboundAt) >= 86400000
    )
      throw new PublicError(
        'The reply window has closed. Wait for the customer to message or send an approved status update.',
        409,
      );
    const next = {
      ...conversation,
      mode: 'human' as const,
      version: conversation.version + 1,
      updatedAt: new Date().toISOString(),
      messages: [
        ...conversation.messages,
        { id: randomUUID(), role: 'staff' as const, text, createdAt: new Date().toISOString() },
      ],
    };
    const jobs =
      conversation.channel === 'whatsapp'
        ? [
            makeJob(conversation.companyId, 'whatsapp_send', {
              conversationId: conversation.id,
              text,
            }),
          ]
        : [];
    if (
      !(await repo.commitTurn(conversation.companyId, next, conversation.version, undefined, jobs))
    )
      throw new PublicError('Conversation changed. Try again.', 409);
    for (const job of jobs) await dispatchJob(repo, job);
    return c.json(next);
  });
  app.post('/api/integrations/:kind', async (c) => {
    owner(c.get('role'));
    const kind = kindSchema.parse(c.req.param('kind'));
    const body = z
      .object({
        config: z.record(z.string(), z.string().max(2048)),
        secret: z.string().max(16000).optional(),
      })
      .parse(await c.req.json());
    const previous = (await repo.getIntegrations(c.get('company').id)).find((i) => i.kind === kind);
    const config = Object.fromEntries(
      Object.entries(body.config).filter(([key]) => integrationKeys[kind].includes(key)),
    );
    const integration: Integration = {
      kind,
      configured: !!body.secret || !!(await repo.getSecret(c.get('company').id, kind)),
      status: 'configured',
      config: { ...previous?.config, ...config },
    };
    if (kind === 'whatsapp' && config.phoneNumberId) {
      const existing = await repo.findCompanyByPhoneNumberId(config.phoneNumberId);
      if (existing && existing.id !== c.get('company').id)
        throw new PublicError('That WhatsApp number is already assigned to another company.');
    }
    await repo.saveIntegration(
      c.get('company').id,
      integration,
      body.secret ? encryptSecret(body.secret) : undefined,
    );
    if (kind === 'whatsapp' && integration.config.wabaId) {
      await (await integrationAdapter(repo, c.get('company').id, 'whatsapp')).subscribe();
    }
    return c.json(integration);
  });
  app.post('/api/integrations/:kind/test', async (c) => {
    owner(c.get('role'));
    const kind = kindSchema.parse(c.req.param('kind'));
    const company = c.get('company');
    const integration = (await repo.getIntegrations(company.id)).find((i) => i.kind === kind);
    const isModel = kind !== 'sheets' && kind !== 'whatsapp';
    const body = isModel
      ? z
          .object({ keyMode: z.enum(['own', 'platform']).optional() })
          .parse(JSON.parse((await c.req.text()) || '{}'))
      : {};
    const keyMode = body.keyMode ?? (company.ai.provider === kind ? company.ai.keyMode : 'own');
    const usePlatform = isModel && keyMode === 'platform';
    if (usePlatform && (company.ai.keyMode !== 'platform' || company.ai.provider !== kind))
      throw new PublicError(
        'Select an authorized platform provider in Settings before testing it.',
        403,
      );
    if (!usePlatform && !integration?.configured)
      throw new PublicError('Save the connection credentials first.');
    try {
      if (kind === 'sheets' || kind === 'whatsapp')
        await (await integrationAdapter(repo, company.id, kind as 'sheets')).test();
      else {
        const key = await providerKey(repo, { ...company, ai: { ...company.ai, keyMode } }, kind);
        const config: { url: string; headers: Record<string, string> } =
          kind === 'openai'
            ? {
                url: 'https://api.openai.com/v1/models',
                headers: { Authorization: `Bearer ${key}` },
              }
            : kind === 'anthropic'
              ? {
                  url: 'https://api.anthropic.com/v1/models',
                  headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
                }
              : {
                  url: 'https://generativelanguage.googleapis.com/v1beta/models',
                  headers: { 'x-goog-api-key': key },
                };
        const response = await fetch(config.url, {
          headers: config.headers as Record<string, string>,
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok)
          throw new PublicError(
            'The provider rejected these credentials. Check the key and account permissions.',
          );
      }
      const checkedAt = new Date().toISOString();
      if (usePlatform)
        return c.json({ kind, keyMode, configured: true, status: 'connected', checkedAt });
      const updated = {
        ...integration!,
        status: 'connected' as const,
        checkedAt,
        error: undefined,
      };
      await repo.saveIntegration(company.id, updated);
      return c.json(updated);
    } catch (error) {
      // Platform tests must not replace the separate business-key connection state.
      if (usePlatform) throw error;
      const updated = {
        ...integration!,
        status: 'error' as const,
        error: sanitizeError(error),
        checkedAt: new Date().toISOString(),
      };
      await repo.saveIntegration(company.id, updated);
      throw error;
    }
  });
  app.post('/api/whatsapp/templates/status', async (c) => {
    owner(c.get('role'));
    return c.json(
      await (
        await integrationAdapter(repo, c.get('company').id, 'whatsapp')
      ).createStatusTemplate(),
    );
  });
  app.get('/api/whatsapp/signup-config', (c) => {
    owner(c.get('role'));
    return c.json({
      enabled:
        appMode() === 'live' &&
        !!env('META_APP_ID') &&
        !!env('META_EMBEDDED_SIGNUP_CONFIG_ID') &&
        !!env('META_APP_SECRET'),
      appId: env('META_APP_ID') || '',
      configId: env('META_EMBEDDED_SIGNUP_CONFIG_ID') || '',
      version: env('META_GRAPH_VERSION') || '',
    });
  });
  app.post('/api/whatsapp/signup', async (c) => {
    owner(c.get('role'));
    if (appMode() !== 'live') throw new PublicError('Embedded Signup requires the live backend.');
    return c.json(
      await finishSignup(repo, c.get('company').id, signupSchema.parse(await c.req.json())),
    );
  });
  app.post('/api/whatsapp/subscribe', async (c) => {
    owner(c.get('role'));
    return c.json(
      await (await integrationAdapter(repo, c.get('company').id, 'whatsapp')).subscribe(),
    );
  });
  app.post('/api/whatsapp/register', async (c) => {
    owner(c.get('role'));
    const { pin } = z.object({ pin: z.string().regex(/^\d{6}$/) }).parse(await c.req.json());
    return c.json(
      await (await integrationAdapter(repo, c.get('company').id, 'whatsapp')).register(pin),
    );
  });
  app.post('/api/jobs/retry', async (c) => {
    owner(c.get('role'));
    await repo.retryFailedJobs(c.get('company').id);
    const due = (await repo.listDueJobs(100)).filter((j) => j.companyId === c.get('company').id);
    for (const job of due) {
      if (appMode() === 'demo') {
        try {
          await processJob(repo, job.id);
        } catch {
          /* Retry state is already saved. */
        }
      } else await dispatchJob(repo, job);
    }
    return c.json({ queued: due.length });
  });
  app.notFound((c) => c.json({ error: 'API route not found.' }, 404));
  return app;
}
