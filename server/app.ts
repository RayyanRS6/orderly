import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { cors } from 'hono/cors';
import { requestId } from 'hono/request-id';
import { createClient } from '@supabase/supabase-js';
import { z, ZodError } from 'zod';
import type { PipelineHealth, Repository } from './repository.js';
import type {
  Company,
  Deal,
  Integration,
  IntegrationKind,
  Order,
  Role,
} from '../src/shared/types.js';
import { createConversation, transitionOrder } from '../src/domain/engine.js';
import { slugify } from '../src/shared/slug.js';
import { appMode, automationPaused, env, workerLeaseMs } from './config.js';
import {
  CATALOG_ID_IN_USE,
  PublicError,
  encryptSecret,
  decryptSecret,
  logFailure,
  safeEqual,
  sanitizeError,
  verifyMetaSignature,
} from './security.js';
import {
  productSchema,
  companySchema,
  chatSchema,
  dealAvailableSchema,
  dealFieldWords,
  dealOrderSchema,
  dealSchema,
  settingsRevision,
  withSettingsRevision,
} from './validation.js';
import { catalogFromRows, parseCsv } from './integrations/catalog.js';
import { modelDefaults, providerKey, validateModelConfiguration } from './integrations/models.js';
import {
  handleTurn,
  integrationAdapter,
  refreshCatalog,
  changeOrderStatus,
  processJob,
  statusNoticeText,
} from './service.js';
import { dispatchJob, makeJob, recoverJobs } from './jobs.js';
import { finishSignup, signupSchema } from './integrations/signup.js';
import { managementRoutes } from './management.js';
import { adminRoutes } from './admin.js';
import { publicMenuRoutes } from './public-menu.js';
import { readiness } from './readiness.js';
import { buildAgentFlow } from './agent-flow.js';
import { verifyProviderKey } from './integrations/model-catalog.js';
import { WhatsAppAdapter } from './integrations/whatsapp.js';
import { whatsappRoutes } from './whatsapp/routes';
import { gatewaySecret } from './whatsapp/client';
import { verifySigned } from './whatsapp/signing';
import { customerKeys, gatewayEventSchema } from '../src/shared/whatsapp';
import { metaEchoText, metaInboundContent } from './whatsapp/inbound';
import {
  receiveGatewayEvent,
  jobAddress,
  requireMeta,
  withConnectionLock,
  metaConfigurationBoundary,
} from './whatsapp/connections';

type Env = {
  Variables: {
    company: Company;
    role: Role;
    userId: string;
    allowedCompanies: Company[];
    // The session passed an authenticator check (aal2). Always true in local demo mode.
    mfaVerified: boolean;
  };
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
// How long an order status change waits for a busy chat before writing its notice copy: up to
// 16 tries half a second apart, about as long as one AI reply takes.
const NOTICE_LOCK_TRIES = 16;
const NOTICE_LOCK_WAIT_MS = 500;
// Deals per business, so the menu page and the bot's catalog stay small.
const MAX_DEALS = 50;
// A request path with its record IDs replaced, for audit entries and failure logs.
const routePattern = (path: string) => path.replace(/\/[a-f0-9-]{36}(?=\/|$)/g, '/:id');
// Only a rejected token means signing in again. When Supabase Auth cannot be reached or is
// failing, the session may be fine, so the dashboard is told to retry instead.
const authUnavailable = (error: unknown) => {
  const e = error as { name?: unknown; status?: unknown } | null;
  return (
    e?.name === 'AuthRetryableFetchError' ||
    (typeof e?.status === 'number' && (e.status === 0 || e.status === 429 || e.status >= 500))
  );
};

export type AppOptions = { waitUntil?: (task: Promise<unknown>) => void };

export function createApp(repo: Repository, options: AppOptions = {}) {
  const app = new Hono<Env>();
  // First, so even a refused origin has a reference that matches its log line.
  app.use('/api/*', requestId());
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
      // The dashboard runs on another origin: it reads how long to wait after a 429 or 503,
      // and the reference that matches a failure to its log line.
      exposeHeaders: ['Retry-After', 'X-Request-Id'],
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
  // A request body that is not JSON is the sender's mistake (400). Any other SyntaxError, such as
  // a mistyped MODEL_PRICING_JSON or an upstream answer that is not JSON, is the server's: it is
  // logged and answered 500 like any unexpected failure.
  app.use('/api/*', async (c, next) => {
    const parse = c.req.json.bind(c.req);
    c.req.json = async () => {
      try {
        return await parse();
      } catch (error) {
        if (error instanceof SyntaxError)
          throw new PublicError('Request body must be valid JSON.', 400);
        throw error;
      }
    };
    await next();
  });
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
    // code: for the dashboard to act on, such as a linked-phone service code.
    if (error instanceof PublicError && !error.cause)
      return c.json(
        { error: error.message, ...(error.code && { code: error.code }) },
        error.status as 400,
      );
    // Unexpected, or a public message hiding its real cause: log one line and return its
    // reference, so a report from the dashboard can be matched to the log.
    const reference = c.get('requestId');
    logFailure(
      'request_failed',
      { method: c.req.method, route: routePattern(c.req.path).slice(0, 120), requestId: reference },
      error,
    );
    return c.json(
      {
        error: sanitizeError(error),
        requestId: reference,
        ...(error instanceof PublicError && error.code && { code: error.code }),
      },
      (error instanceof PublicError ? error.status : 500) as 400,
    );
  });
  app.get('/api/config', (c) =>
    c.json({
      mode: appMode(),
      supabaseUrl: process.env.SUPABASE_URL || '',
      supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
      // The platform-wide emergency stop (ORDERLY_PAUSE_AUTOMATION), for a dashboard notice.
      automationPaused: automationPaused(),
    }),
  );
  app.get('/api/health', (c) => c.json({ ok: true, mode: appMode() }));
  // For an outside uptime monitor: whether saved work is being sent. Off (404, like any unknown
  // route) unless HEALTH_CHECK_TOKEN is set and sent as a bearer token. Coarse counts only, never
  // a business, a number or a message.
  app.get('/api/health/pipeline', async (c) => {
    const token = env('HEALTH_CHECK_TOKEN');
    if (!token || !safeEqual(c.req.header('authorization') || '', `Bearer ${token}`))
      return c.json({ error: 'API route not found.' }, 404);
    c.header('Cache-Control', 'no-store');
    let health: PipelineHealth;
    try {
      health = await repo.pipelineHealth();
    } catch (error) {
      // A missing migration (503) or a database that cannot answer: never reported healthy.
      if (!(error instanceof PublicError))
        logFailure('pipeline_health_failed', { route: '/api/health/pipeline' }, error);
      return c.json({ status: 'unavailable' }, 503);
    }
    const {
      status,
      stalledJobs,
      oldestDueAt,
      schedulerConfigured,
      recoveryScheduled,
      dbSizeBytes,
    } = health;
    return c.json(
      { status, stalledJobs, oldestDueAt, schedulerConfigured, recoveryScheduled, dbSizeBytes },
      status === 'ok' ? 200 : 503,
    );
  });
  app.post('/api/whatsapp/gateway/events', async (c) => {
    const raw = await c.req.text();
    const nonce = verifySigned(
      gatewaySecret(),
      'event',
      '/api/whatsapp/gateway/events',
      raw,
      c.req.raw.headers,
    );
    if (!nonce || !(await repo.consumeGatewayNonce(nonce)))
      throw new PublicError('Invalid or replayed gateway request.', 401);
    await receiveGatewayEvent(repo, gatewayEventSchema.parse(JSON.parse(raw)));
    return c.json({ received: true });
  });
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
        const connection = await repo.getWhatsAppConnection(company.id);
        if (
          connection &&
          (connection.provider !== 'meta' ||
            ['disconnected', 'logged_out'].includes(connection.status))
        )
          continue;
        const bindMeta = (peer: string) =>
          connection
            ? {
                whatsappAddress: {
                  connectionId: connection.id,
                  generation: connection.generation,
                  provider: 'meta',
                  peer,
                },
                streamKey: `${connection.id}:${connection.generation}:${peer}`,
              }
            : {};
        for (const status of value.statuses ?? []) {
          const errorCode = Number(status.errors?.[0]?.code) || 'unknown';
          if (
            ['sent', 'delivered', 'read', 'failed'].includes(status.status) &&
            typeof status.id === 'string'
          )
            await repo.recordDelivery(
              company.id,
              status.id,
              status.status,
              undefined,
              undefined,
              status.errors?.length
                ? `Meta delivery error ${errorCode}. Check the business number and account health.`
                : undefined,
            );
          // The receipt above shows on the message. Only a failed delivery also gets a trace, and
          // never with the message ID: Meta's ID encodes the customer's number, and a trace linked
          // to no chat is not removed when the customer is erased.
          if (status.status === 'failed')
            await repo.addTrace({
              id: randomUUID(),
              companyId: company.id,
              action: 'whatsapp.failed',
              detail: `Meta could not deliver a message (error ${errorCode}). Check the business number and account health.`,
              createdAt: new Date().toISOString(),
            });
        }
        if (change.field === 'smb_message_echoes') {
          for (const echo of value.message_echoes ?? []) {
            if (typeof echo.id !== 'string' || typeof echo.to !== 'string') continue;
            // A staff reaction is not a takeover: it must not pause the bot for this customer.
            const text = metaEchoText(echo);
            if (text === undefined) continue;
            const job = makeJob(company.id, 'incoming', {
              ...bindMeta(echo.to),
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
          // A blocked number's message is dropped before anything is saved; Meta still gets 200.
          if (await repo.findBlockedCustomer(company.id, customerKeys({ phone: message.from })))
            continue;
          const content = metaInboundContent(message);
          if ('ignore' in content) {
            // Nothing to answer, so no job: the chat and its 24-hour window stay as they are.
            await repo.addTrace({
              id: randomUUID(),
              companyId: company.id,
              ...content.trace,
              createdAt: new Date().toISOString(),
            });
            continue;
          }
          const job = makeJob(company.id, 'incoming', {
            ...bindMeta(message.from),
            phone: message.from,
            messageId: message.id,
            text: content.text,
            action: content.action,
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
  // The public menu page needs no sign-in, so its routes come before the auth check below.
  app.route('/api/public', publicMenuRoutes(repo));
  app.use('/api/*', async (c, next) => {
    const mode = appMode();
    let allowed: Company[];
    let userId = 'local-demo-admin';
    let mfaVerified = mode === 'demo';
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
        // A hanging sign-in check becomes a retryable error, well before the browser gives up.
        global: {
          fetch: (input, init) =>
            fetch(input, {
              ...init,
              signal: init?.signal
                ? AbortSignal.any([init.signal, AbortSignal.timeout(10000)])
                : AbortSignal.timeout(10000),
            }),
        },
      });
      const { data, error } = await client.auth
        .getUser(bearer)
        .catch(() => ({ data: { user: null }, error: { name: 'AuthRetryableFetchError' } }));
      if (error && authUnavailable(error)) {
        c.header('Retry-After', '5');
        throw new PublicError('Sign-in service is busy, please retry.', 503);
      }
      if (error || !data.user) throw new PublicError('Your session expired. Sign in again.', 401);
      if (data.user.factors?.some((f) => f.status === 'verified')) {
        let assurance = '';
        try {
          assurance = JSON.parse(Buffer.from(bearer.split('.')[1], 'base64url').toString()).aal;
        } catch {}
        // getUser above verifies this token with Supabase before claims are inspected.
        if (assurance !== 'aal2')
          throw new PublicError(
            'Complete authenticator verification to access this workspace.',
            403,
          );
        mfaVerified = true;
      }
      userId = data.user.id;
      // Both at once: neither depends on the other, and each one is a trip to the database.
      const [withinLimit, companies] = await Promise.all([
        repo.consumeRateLimit(`user:${userId}`, 180),
        repo.listAllowedCompanies(userId),
      ]);
      if (!withinLimit) {
        c.header('Retry-After', '60');
        throw new PublicError('Too many requests. Please wait a minute.', 429);
      }
      allowed = companies;
    }
    c.set('userId', userId);
    c.set('mfaVerified', mfaVerified);
    c.set('allowedCompanies', allowed);
    const slug = c.req.query('companySlug');
    const companyId = slug
      ? allowed.find((x) => x.slug === slug)?.id
      : c.req.query('companyId') || c.req.header('x-company-id') || allowed[0]?.id;
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
    // Admin routes audit against the business they change, not the one that happens to be open.
    if (
      c.res.ok &&
      !['GET', 'OPTIONS'].includes(c.req.method) &&
      c.req.path !== '/api/chat' &&
      // A status check every few seconds, not a change.
      c.req.path !== '/api/whatsapp/pairing-status' &&
      !c.req.path.startsWith('/api/admin/')
    ) {
      const action = `${c.req.method} ${routePattern(c.req.path)}`;
      // After the response where the runtime allows it: the change is saved already.
      if (options.waitUntil)
        options.waitUntil(
          repo
            .audit(company.id, userId, action)
            .catch(() => console.warn(`Orderly: the audit entry for ${action} was not saved.`)),
        );
      else await repo.audit(company.id, userId, action);
    }
  });
  app.route('/api', managementRoutes(repo));
  app.route('/api/admin', adminRoutes(repo));
  for (const path of ['/api/integrations/whatsapp', '/api/whatsapp/signup'])
    app.use(path, async (c, next) => {
      if (c.req.method === 'POST') return withConnectionLock(repo, c.get('company').id, next);
      await next();
    });
  app.route('/api/whatsapp', whatsappRoutes(repo));
  app.get('/api/account', async (c) =>
    c.json({
      isAdmin: appMode() === 'demo' || (await repo.isAdmin(c.get('userId'))),
      companyCount: c.get('allowedCompanies').length,
    }),
  );
  app.get('/api/agent-flow', async (c) =>
    c.json(await buildAgentFlow(repo, c.get('company'), c.get('role'))),
  );
  app.get('/api/bootstrap', async (c) => {
    const company = c.get('company');
    const [products, deals, orderPage, conversationPage, integrations, summary, traces, checks] =
      await Promise.all([
        repo.listProducts(company.id),
        repo.listDeals(company.id),
        repo.queryOrders(company.id, { pageSize: 50, sandbox: appMode() === 'demo' }),
        repo.queryConversations(company.id, { pageSize: 50, sandbox: appMode() === 'demo' }),
        repo.getIntegrations(company.id),
        repo.getSummary(company.id, appMode() === 'demo'),
        repo.listTraces(company.id),
        readiness(repo, company),
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
      // Sent back with a settings save, so a save from an older copy is refused (STALE_SETTINGS).
      company: withSettingsRevision(company),
      companies: c.get('allowedCompanies'),
      products,
      deals,
      orders: orderPage.items,
      conversations: conversationPage.items,
      integrations: allIntegrations,
      aiConnection: {
        provider: company.ai.provider,
        configured: aiKeyConfigured,
      },
      usage: [],
      summary,
      readiness: checks,
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
      slug: `${slugify(body.name)}-${id.slice(0, 6)}`,
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
        monthlyBudgetUsd: 10,
      },
      createdAt: new Date().toISOString(),
      settingsRevision: 0,
    };
    await repo.saveCompany(company);
    return c.json(company, 201);
  });
  app.put('/api/companies/:id', async (c) => {
    owner(c.get('role'));
    const stored = c.get('company');
    if (c.req.param('id') !== stored.id) throw new PublicError('Company not found.', 404);
    const input = await c.req.json();
    // Every save echoes the slug back. A business created before slugs were cleaned up may
    // hold one the schema refuses, and its own slug must never block a save.
    if (input && typeof input === 'object' && input.slug === stored.slug) delete input.slug;
    const body = companySchema.parse(input);
    const revision = settingsRevision(stored);
    // A copy of the settings older than the stored ones (another tab, another person, or a
    // change made in Bot settings) must not undo the newer change. Only pausing automation
    // always goes through, and then nothing else from the old copy is saved. A dashboard from
    // before revisions sends none and saves as before.
    if (body.settingsRevision !== undefined && body.settingsRevision !== revision) {
      if (!(stored.botEnabled && body.botEnabled === false))
        return c.json(
          {
            error:
              'Settings changed in another tab or by another person. Reload to see the latest settings.',
            code: 'STALE_SETTINGS',
          },
          409,
        );
      const paused: Company = { ...stored, botEnabled: false, settingsRevision: revision + 1 };
      await repo.saveCompany(paused);
      return c.json(paused);
    }
    // Fields the server manages keep their stored values whatever the body says: a stale or
    // edited copy must not approve AI data sharing, stop Sheet refreshes (a future
    // catalogSyncedAt), rename the workspace URL or allow linked-phone pairing.
    const { id, slug, createdAt, privacy, linkedDeviceAllowed } = stored;
    const company: Company = {
      ...stored,
      ...body,
      id,
      slug,
      createdAt,
      // A menu read from the other source is not a last good Sheet menu: after a switch the
      // next chat reads the Sheet afresh.
      catalogSyncedAt:
        body.catalogSource === stored.catalogSource ? stored.catalogSyncedAt : undefined,
      privacy,
      linkedDeviceAllowed,
      settingsRevision: revision + 1,
    };
    validateModelConfiguration(company);
    // The AI data approval was given for one provider and model; another needs a new one,
    // which only Connect and test records.
    if (company.ai.provider !== stored.ai.provider || company.ai.model !== stored.ai.model)
      company.privacy = { aiDataApproved: false, retentionDays: privacy?.retentionDays ?? 0 };
    // Only settings that change which model runs need a new test; a budget change does not.
    const tested = (ai: Company['ai']) =>
      JSON.stringify([ai.provider, ai.model, ai.pricing ?? null]);
    if (tested(company.ai) !== tested(stored.ai)) company.modelVerification = undefined;
    // During the platform-wide stop a bot cannot be switched on; one already on stays as it is,
    // so its other settings still save.
    if (company.botEnabled && !stored.botEnabled && automationPaused())
      throw new PublicError(
        'Automatic replies are paused across Orderly right now, so automation cannot be switched on. Nothing was saved: save your other changes with automation off, or try again later.',
        409,
      );
    if (appMode() === 'live' && company.botEnabled) {
      const missing = (await readiness(repo, company)).filter((check) => !check.ready);
      if (missing.length)
        throw new PublicError(
          `Before enabling automation: ${missing.map((check) => check.label).join('; ')}.`,
          409,
        );
    }
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
  // Deals are edited here whatever the menu source: imports and Sheets refreshes leave them be.
  app.post('/api/deals', async (c) => {
    owner(c.get('role'));
    const company = c.get('company');
    const parsed = dealSchema.safeParse(await c.req.json(), { error: dealFieldWords });
    // The Deals editor shows this in its dialog: one plain sentence, not field paths.
    if (!parsed.success) throw new PublicError(parsed.error.issues[0]!.message, 400);
    const body = parsed.data;
    const [deals, products] = await Promise.all([
      repo.listDeals(company.id),
      repo.listProducts(company.id),
    ]);
    const stored = body.id ? deals.find((d) => d.id === body.id) : undefined;
    if (body.id && !stored) throw new PublicError('Deal not found.', 404);
    const tooMany = () =>
      new PublicError(
        `You can have up to ${MAX_DEALS} deals. Delete one you no longer use first.`,
        409,
      );
    if (!stored && deals.length >= MAX_DEALS) throw tooMany();
    // Only a link added or changed now must point at the menu. One saved before is kept when its
    // item has gone (a Sheet can give items new ids): the Deals tab warns about it instead.
    const link = (item: { productId?: string; variantId?: string }) =>
      JSON.stringify([item.productId, item.variantId ?? null]);
    const kept = new Set(stored?.items.map(link));
    for (const item of body.items) {
      if (!item.productId || kept.has(link(item))) continue;
      const product = products.find((p) => p.id === item.productId);
      if (!product) throw new PublicError(`${item.name} is no longer on your menu.`, 422);
      if (item.variantId && !product.variants.some((v) => v.id === item.variantId))
        throw new PublicError(`Choose a size for ${product.name}.`, 422);
    }
    const id = stored?.id ?? randomUUID();
    if (products.some((p) => p.id === id)) throw new PublicError(CATALOG_ID_IN_USE, 409);
    const deal: Deal = {
      ...body,
      id,
      companyId: company.id,
      position: stored?.position ?? Math.max(0, ...deals.map((d) => d.position)) + 1,
      updatedAt: new Date().toISOString(),
    };
    await repo.saveDeal(deal);
    // Two new deals saved at once (two phones) can both pass the count above. Counting again
    // after saving, and taking this one back when over the limit, holds it in either store: the
    // later save always sees both. When each sees the other, both are refused, which is safe.
    if (!stored && (await repo.listDeals(company.id)).length > MAX_DEALS) {
      await repo.deleteDeal(company.id, id);
      throw tooMany();
    }
    return c.json(deal);
  });
  // Pause or resume at once, say when an item runs out: nothing else is checked or changed.
  app.post('/api/deals/:id/available', async (c) => {
    owner(c.get('role'));
    const company = c.get('company');
    const { available } = dealAvailableSchema.parse(await c.req.json());
    const stored = (await repo.listDeals(company.id)).find((d) => d.id === c.req.param('id'));
    if (!stored) throw new PublicError('Deal not found.', 404);
    const deal: Deal = { ...stored, available, updatedAt: new Date().toISOString() };
    await repo.saveDeal(deal);
    return c.json(deal);
  });
  app.post('/api/deals/order', async (c) => {
    owner(c.get('role'));
    const company = c.get('company');
    const { ids } = dealOrderSchema.parse(await c.req.json());
    const deals = await repo.listDeals(company.id);
    if (ids.some((id) => !deals.some((d) => d.id === id)))
      throw new PublicError('Deal not found.', 404);
    // Deals the list leaves out (one just added in another tab) follow, in their own order.
    const rest = deals
      .filter((d) => !ids.includes(d.id))
      .sort((a, b) => a.position - b.position)
      .map((d) => d.id);
    await repo.setDealPositions(company.id, [...ids, ...rest]);
    return c.json({ ok: true });
  });
  app.delete('/api/deals/:id', async (c) => {
    owner(c.get('role'));
    await repo.deleteDeal(c.get('company').id, c.req.param('id'));
    return c.json({ ok: true });
  });
  app.post('/api/chat', async (c) => {
    const company = c.get('company');
    // The platform-wide stop: no AI call, so no test chat either.
    if (automationPaused())
      throw new PublicError(
        'Automatic replies are paused on Orderly right now. Try again later.',
        503,
      );
    // Test chats spend the business's own AI budget, which live customers also need. One
    // business gets 15 a minute however many people test, checked before any AI work.
    if (!(await repo.consumeRateLimit(`chat:${company.id}`, 15))) {
      c.header('Retry-After', '60');
      throw new PublicError('Too many test messages. Please wait a minute.', 429);
    }
    const body = chatSchema.parse(await c.req.json());
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
    const body = z
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
        // Staff's own note, such as what the customer said on the phone, kept with the order.
        note: z.string().trim().max(500).optional(),
      })
      .parse(await c.req.json());
    // A dashboard from before Accept went straight to 'preparing' still asks for 'accepted'.
    const status = body.status === 'accepted' ? 'preparing' : body.status;
    const company = c.get('company');
    const order = await repo.getOrder(company.id, c.req.param('id'));
    if (!order) throw new PublicError('Order not found.', 404);
    // Another staff member made this change first: their answer stands, and this note would be
    // lost without a word (only a change saves a note). The same note again is a harmless retry.
    if (body.note && order.status === status && order.staffNote?.text !== body.note)
      throw new PublicError('Another staff member changed this order. Refresh and try again.', 409);
    const now = new Date().toISOString();
    // Only the order rules' own message reaches staff ("Cannot change …"). Anything else, such
    // as a database failure, is logged and answered with the general error.
    try {
      transitionOrder(order, status, now);
    } catch (error) {
      throw new PublicError(error instanceof Error ? error.message : 'Invalid order transition.');
    }
    // The customer is told in their language; the chat keeps a copy of exactly what was sent.
    const conversation = await repo.getConversation(order.companyId, order.conversationId);
    const text = statusNoticeText(company, conversation, order, status);
    const updated = await changeOrderStatus(repo, order, status, now, undefined, text, {
      conversation: conversation ?? null,
      note: body.note ? { text: body.note, at: now, actorId: c.get('userId') } : undefined,
      defer: options.waitUntil,
    });
    // The order already had this status: nothing was sent, so the chat gets no notice either.
    if (updated.status === order.status) return c.json(updated);
    // Staff get their answer now; the chat's copy follows (it may wait for a busy chat).
    const copied = addStatusNoticeCopy(order, text, now);
    if (options.waitUntil) options.waitUntil(copied);
    else await copied;
    return c.json(updated);
  });
  // The chat's copy of the status message the customer is sent. Marked as a notice, so a
  // customer still waiting for a staff reply stays under "Needs staff" and in staff alerts.
  // Written under the chat's lock like a turn, so it never lands in the middle of one (that turn
  // would start again and pay for its AI call twice). A chat still busy after a few seconds is
  // written to anyway: the customer has the notice, so the chat needs its copy. A chat that
  // changed meanwhile is read again. Never throws: the status change is saved already. The copy is
  // dated and placed at its status change, so two quick changes waiting on a busy chat still read
  // in order.
  async function addStatusNoticeCopy(order: Order, text: string, changedAt: string) {
    try {
      const lockId = randomUUID();
      let locked = false;
      for (let wait = 0; wait < NOTICE_LOCK_TRIES; wait++) {
        locked = await repo.acquireConversationLock(
          order.companyId,
          order.conversationId,
          lockId,
          new Date(Date.now() + workerLeaseMs()).toISOString(),
        );
        if (locked) break;
        await new Promise((resolve) => setTimeout(resolve, NOTICE_LOCK_WAIT_MS));
      }
      try {
        for (let attempt = 1; attempt <= 3; attempt++) {
          const conversation = await repo.getConversation(order.companyId, order.conversationId);
          if (!conversation) break;
          const notice = {
            id: randomUUID(),
            role: 'staff' as const,
            text,
            createdAt: changedAt,
            notice: true,
          };
          let index = conversation.messages.length;
          while (index > 0 && conversation.messages[index - 1]!.createdAt > changedAt) index--;
          const next = {
            ...conversation,
            version: conversation.version + 1,
            updatedAt: new Date().toISOString(),
            messages: [
              ...conversation.messages.slice(0, index),
              notice,
              ...conversation.messages.slice(index),
            ],
          };
          if (await repo.saveConversation(next, conversation.version)) break;
          if (attempt === 3)
            console.warn('Orderly: an order status notice could not be added to its chat.');
        }
      } finally {
        if (locked)
          await repo.releaseConversationLock(order.companyId, order.conversationId, lockId);
      }
    } catch {
      console.warn('Orderly: an order status notice could not be added to its chat.');
    }
  }
  app.post('/api/conversations/:id/mode', async (c) => {
    const { mode } = z.object({ mode: z.enum(['bot', 'human']) }).parse(await c.req.json());
    const conversation = await repo.getConversation(c.get('company').id, c.req.param('id'));
    if (!conversation) throw new PublicError('Conversation not found.', 404);
    if (conversation.blocked) throw new PublicError('Unblock this number first.', 409);
    const now = new Date().toISOString();
    const next = {
      ...conversation,
      mode,
      // Staff decided explicitly; the bot must not take the chat back on its own.
      botPausedAt: undefined,
      limitPause: undefined,
      botResumedAt: mode === 'bot' ? now : conversation.botResumedAt,
      // Taken over from the bot: the customer waits for staff from now at the earliest, since
      // the bot answered them before, so a takeover hours later is not overdue at once. A chat
      // already with staff (handed over, or paused) keeps its clock.
      humanSince:
        mode === 'bot' ? undefined : conversation.mode === 'bot' ? now : conversation.humanSince,
      version: conversation.version + 1,
      updatedAt: now,
    };
    if (!(await repo.saveConversation(next, conversation.version)))
      throw new PublicError('Conversation changed. Try again.', 409);
    return c.json(next);
  });
  // Any team member can block a number, like taking over a chat. The block covers every
  // identity known for the customer, so it still applies after WhatsApp reconnects.
  app.post('/api/conversations/:id/block', async (c) => {
    const { blocked } = z
      .object({ blocked: z.boolean() })
      .strict()
      .parse(await c.req.json());
    const company = c.get('company');
    const conversation = await repo.getConversation(company.id, c.req.param('id'));
    if (!conversation) throw new PublicError('Conversation not found.', 404);
    const keys = customerKeys({
      phone: conversation.customerPhone,
      peer: conversation.whatsappAddress?.peer,
    });
    if (!blocked) {
      // Unblock the person, not only this chat's mark: any block holding one of their numbers
      // goes too, so "Number unblocked" is true.
      const blockIds = new Set(conversation.blocked ? [conversation.blocked.blockId] : []);
      if (keys.length)
        for (const block of await repo.listBlockedCustomers(company.id))
          if (block.keys.some((key) => keys.includes(key))) blockIds.add(block.blockId);
      for (const blockId of blockIds) await repo.unblockCustomer(company.id, blockId);
    } else {
      if (conversation.channel !== 'whatsapp' || !keys.length)
        throw new PublicError('Only a real WhatsApp customer can be blocked.', 400);
      await repo.blockCustomer(
        company.id,
        conversation.id,
        randomUUID(),
        keys,
        conversation.customerName || conversation.customerPhone || 'WhatsApp contact',
        c.get('userId'),
      );
    }
    // Read back like the other chat routes, so delivery ticks stay on the messages.
    return c.json((await repo.getConversation(company.id, conversation.id)) ?? conversation);
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
      // A blocked number sends nothing more to answer, so a reply to it must not put the chat
      // back under "Needs staff".
      mode: conversation.blocked ? conversation.mode : ('human' as const),
      botPausedAt: undefined,
      limitPause: undefined,
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
              ...jobAddress(conversation),
              conversationId: conversation.id,
              messageId: next.messages.at(-1)?.id,
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
    if (kind === 'whatsapp') {
      await requireMeta(repo, c.get('company').id);
      const token =
        body.secret || decryptSecret((await repo.getSecret(c.get('company').id, kind)) || '');
      const adapter = new WhatsAppAdapter(integration, token);
      await adapter.verifyOwnership();
      const { displayPhoneNumber } = (await adapter.test()) ?? {};
      if (displayPhoneNumber) integration.config.displayPhoneNumber = displayPhoneNumber;
      await adapter.subscribe();
      integration.config.ownershipVerifiedAt = new Date().toISOString();
      integration.status = 'connected';
      integration.checkedAt = new Date().toISOString();
    }
    if (kind === c.get('company').ai.provider || kind === 'whatsapp')
      await repo.saveCompany({
        ...c.get('company'),
        botEnabled: false,
        modelVerification: undefined,
        // A new key may belong to another account, so its terms are approved again.
        privacy:
          kind === c.get('company').ai.provider
            ? {
                aiDataApproved: false,
                retentionDays: c.get('company').privacy?.retentionDays ?? 0,
              }
            : c.get('company').privacy,
      });
    if (kind === 'whatsapp')
      await metaConfigurationBoundary(repo, c.get('company').id, integration.config.phoneNumberId);
    await repo.saveIntegration(
      c.get('company').id,
      integration,
      body.secret ? encryptSecret(body.secret) : undefined,
    );
    return c.json(integration);
  });
  app.post('/api/integrations/:kind/test', async (c) => {
    owner(c.get('role'));
    const kind = kindSchema.parse(c.req.param('kind'));
    const company = c.get('company');
    const integration = (await repo.getIntegrations(company.id)).find((i) => i.kind === kind);
    if (!integration?.configured) throw new PublicError('Save the connection credentials first.');
    try {
      let displayPhoneNumber: string | undefined;
      if (kind === 'whatsapp')
        ({ displayPhoneNumber } =
          (await (await integrationAdapter(repo, company.id, 'whatsapp')).test()) ?? {});
      else if (kind === 'sheets')
        // With the menu read from the Sheet, the test also reads and checks the menu tab.
        await (
          await integrationAdapter(repo, company.id, 'sheets')
        ).test(company.catalogSource === 'sheets' ? { menuFor: company.id } : {});
      else await verifyProviderKey(kind, await providerKey(repo, company, kind));
      const checkedAt = new Date().toISOString();
      const updated = {
        ...integration!,
        ...(displayPhoneNumber && {
          config: { ...integration!.config, displayPhoneNumber },
        }),
        status: 'connected' as const,
        checkedAt,
        error: undefined,
      };
      await repo.saveIntegration(company.id, updated);
      return c.json(updated);
    } catch (error) {
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
