import { Hono } from 'hono';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type {
  Account,
  AiDataApproval,
  Company,
  Conversation,
  Order,
  Role,
  ListFilter,
  BotSettings,
  TeamMember,
} from '../src/shared/types';
import type { Repository } from './repository';
import { PublicError } from './security';
import { AI_TERMS_VERSION, botSchema, settingsRevision } from './validation';
import { normalizeTypedPhone } from '../src/shared/menu';
import { defaultBot, configuredCompany } from '../src/shared/bot';
import { availableModels, modelFingerprint, verifyProviderKey } from './integrations/model-catalog';
import { AiModelAdapter, providerKey, validateModelConfiguration } from './integrations/models';
import { encryptSecret } from './security';
import { PROVIDER_NAMES } from '../src/shared/models';
import { createConversation } from '../src/domain/engine';
import { readiness } from './readiness';
import { appMode } from './config';
import { addMemberByEmail } from './team';
import { emailAlertsAvailable } from './integrations/alerts';
import { disconnectGateway } from './whatsapp/connections';
import { baseSlug, menuLinkStatus, refreshDisplayNumber, whatsappNumberFor } from './menu';

export type AppEnv = {
  Variables: {
    company: Company;
    role: Role;
    userId: string;
    allowedCompanies: Company[];
    mfaVerified: boolean;
  };
};
export function managementRoutes(repo: Repository) {
  const app = new Hono<AppEnv>();
  const owner = (role: Role) => {
    if (role === 'staff') throw new PublicError('Only an owner can manage this setting.', 403);
  };
  app.get('/notifications', async (c) =>
    c.json({
      ...(await repo.alertPreferences(c.get('company').id, c.get('userId'))),
      available: emailAlertsAvailable(),
    }),
  );
  app.put('/notifications', async (c) => {
    const { enabled, responseMinutes } = z
      .object({ enabled: z.boolean(), responseMinutes: z.number().int().min(5).max(120) })
      .strict()
      .parse(await c.req.json());
    if (enabled && !emailAlertsAvailable())
      throw new PublicError(
        'Email alerts require a configured mail service and verified sender.',
        409,
      );
    return c.json({
      ...(await repo.configureAlerts(
        c.get('company').id,
        c.get('userId'),
        enabled,
        responseMinutes,
      )),
      available: emailAlertsAvailable(),
    });
  });
  app.get('/attention', async (c) => c.json(await repo.staffAttention(c.get('company').id)));
  // Spam protection: the AI replies used this hour, and the numbers staff blocked.
  app.get('/ai-limits', async (c) => c.json(await repo.aiLimitStatus(c.get('company').id)));
  app.get('/blocked', async (c) => c.json(await repo.listBlockedCustomers(c.get('company').id)));
  app.delete('/blocked/:blockId', async (c) => {
    const blockId = z.string().min(1).max(100).parse(c.req.param('blockId'));
    if (!(await repo.unblockCustomer(c.get('company').id, blockId)))
      throw new PublicError('This number is not blocked any more.', 404);
    return c.json({ ok: true });
  });
  const retentionDays = z
    .number()
    .int()
    .refine((n) => n === 0 || (n >= 30 && n <= 3650), 'Choose 0 (off) or 30–3650 days.');
  app.get('/privacy/retention', async (c) => {
    owner(c.get('role'));
    const days = retentionDays.parse(Number(c.req.query('days') ?? 0));
    return c.json(await repo.retentionStatus(c.get('company').id, days));
  });
  app.put('/privacy/retention', async (c) => {
    owner(c.get('role'));
    const { days } = z
      .object({ days: retentionDays, confirmed: z.literal(true) })
      .parse(await c.req.json());
    return c.json(await repo.configureRetention(c.get('company').id, days, c.get('userId')));
  });
  const filterSchema = z.object({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(50),
    search: z.string().max(150).optional(),
    status: z.string().max(30).optional(),
    sandbox: z.enum(['true', 'false']).optional(),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
  });
  const filters = (query: Record<string, string>): ListFilter => {
    const f = filterSchema.parse(query);
    return { ...f, sandbox: f.sandbox === undefined ? appMode() === 'demo' : f.sandbox === 'true' };
  };
  app.get('/orders', async (c) =>
    c.json(await repo.queryOrders(c.get('company').id, filters(c.req.query()))),
  );
  app.get('/orders/:id', async (c) => {
    const o = await repo.getOrder(c.get('company').id, c.req.param('id'));
    if (!o) throw new PublicError('Order not found.', 404);
    return c.json(o);
  });
  app.get('/conversations', async (c) =>
    c.json(await repo.queryConversations(c.get('company').id, filters(c.req.query()))),
  );
  app.get('/conversations/:id', async (c) => {
    const conversation = await repo.getConversation(c.get('company').id, c.req.param('id'));
    if (!conversation) throw new PublicError('Conversation not found.', 404);
    return c.json(conversation);
  });
  app.get('/conversations/:id/messages', async (c) =>
    c.json(
      await repo.conversationHistory(
        c.get('company').id,
        c.req.param('id'),
        z.coerce
          .number()
          .int()
          .min(1)
          .parse(c.req.query('page') ?? 1),
      ),
    ),
  );
  app.get('/activity', async (c) => {
    const id = c.get('company').id;
    const [summary, traces, jobs, orders] = await Promise.all([
      repo.getSummary(id, appMode() === 'demo'),
      repo.listTraces(id),
      repo.listCompanyJobs(id),
      repo.queryOrders(id, { pageSize: 50, sandbox: appMode() === 'demo' }),
    ]);
    return c.json({
      summary,
      orders: orders.items,
      traces: traces.slice(0, 50),
      jobs: jobs.map(({ payload, ...j }) => j),
    });
  });
  app.get('/readiness', async (c) => c.json(await readiness(repo, c.get('company'))));
  app.get('/models', async (c) => {
    owner(c.get('role'));
    const company = c.get('company');
    const provider = z
      .enum(['mock', 'openai', 'gemini', 'anthropic'])
      .parse(c.req.query('provider') ?? company.ai.provider);
    return c.json(
      await availableModels(
        repo,
        { ...company, ai: { ...company.ai, provider } },
        c.req.query('refresh') === 'true',
      ),
    );
  });
  // One step for owners: check the key, run a test reply with the exact model, and only
  // then save the key and switch this business to the new model. Any failure changes nothing.
  app.post('/ai/connect', async (c) => {
    owner(c.get('role'));
    const company = c.get('company');
    const body = z
      .object({
        provider: z.enum(['openai', 'anthropic', 'gemini']),
        model: z.string().trim().min(1).max(120),
        apiKey: z.string().trim().min(10).max(16000).optional(),
        // Sent by dashboards still open from before every business used its own key.
        // Accepted and ignored: the business's own key is always used.
        keyMode: z.enum(['own', 'platform']).optional(),
        approve: z.literal(true, {
          error: 'Tick the agreement to send customer messages to this AI provider.',
        }),
        // What the owner confirms about the provider account. Optional here only so that a
        // dashboard from before it existed gets a clear message below.
        attest: z
          .object({
            noTrainingOptIn: z.literal(true, {
              error: 'Confirm that no data-sharing or training opt-in is on for this account.',
            }),
            paidTier: z.boolean().optional(),
          })
          .strict()
          .optional(),
        monthlyBudgetUsd: z.number().min(0).max(10000).optional(),
        pricing: z
          .tuple([z.number().positive().max(1000), z.number().positive().max(1000)])
          .optional(),
      })
      .strict()
      .parse(await c.req.json());
    if (!body.attest) throw new PublicError('Please reload the page to continue.', 400);
    // Google may use and have people read what is sent to an unpaid Gemini key.
    if (body.provider === 'gemini' && body.attest.paidTier !== true)
      throw new PublicError(
        'Confirm that this key’s Google Cloud project has billing turned on (paid tier). Free-tier keys must not receive customer messages.',
        400,
      );
    const monthlyBudgetUsd = body.monthlyBudgetUsd ?? company.ai.monthlyBudgetUsd;
    const approval: AiDataApproval = {
      provider: body.provider,
      userId: c.get('userId'),
      at: new Date().toISOString(),
      version: AI_TERMS_VERSION,
      noTrainingOptIn: true,
      paidTierAttested: body.attest.paidTier === true,
    };
    const candidate: Company = {
      ...company,
      ai: {
        provider: body.provider,
        model: body.model,
        monthlyBudgetUsd,
        ...(body.pricing && { pricing: body.pricing }),
      },
      privacy: {
        aiDataApproved: true,
        retentionDays: company.privacy?.retentionDays ?? 0,
        aiApproval: approval,
      },
    };
    validateModelConfiguration(candidate);
    const key = body.apiKey ?? (await providerKey(repo, candidate));
    await verifyProviderKey(body.provider, key);
    try {
      await new AiModelAdapter(repo, key).interpret(
        configuredCompany(candidate),
        await repo.listProducts(company.id),
        createConversation(
          company.id,
          `model-test-${randomUUID()}`,
          'demo',
          new Date().toISOString(),
        ),
        'Hello. Please show the menu.',
      );
    } catch (error) {
      throw new PublicError(
        `The key works, but ${PROVIDER_NAMES[body.provider]} model “${body.model}” could not answer a test message. ${
          error instanceof PublicError
            ? error.message
            : 'Check the model name and your account credit.'
        }`,
        422,
        // Kept so the failure log shows the provider's error name and status.
        { cause: error },
      );
    }
    const checkedAt = new Date().toISOString();
    if (body.apiKey) {
      const previous = (await repo.getIntegrations(company.id)).find(
        (integration) => integration.kind === body.provider,
      );
      await repo.saveIntegration(
        company.id,
        {
          kind: body.provider,
          configured: true,
          status: 'connected',
          checkedAt,
          config: { ...previous?.config },
        },
        encryptSecret(body.apiKey),
      );
    }
    const latest = (await repo.getCompany(company.id)) ?? company;
    await repo.saveCompany({
      ...latest,
      // A settings copy from before this switch must not save the old model back.
      settingsRevision: settingsRevision(latest) + 1,
      ai: candidate.ai,
      privacy: {
        aiDataApproved: true,
        retentionDays: latest.privacy?.retentionDays ?? candidate.privacy?.retentionDays ?? 0,
        aiApproval: approval,
      },
      modelVerification: { fingerprint: modelFingerprint(candidate, key), checkedAt },
    });
    await repo.audit(company.id, c.get('userId'), `ai.connected.${body.provider}`);
    return c.json({
      ok: true,
      provider: body.provider,
      model: body.model,
      checkedAt,
    });
  });
  app.post('/models/test', async (c) => {
    owner(c.get('role'));
    const company = c.get('company');
    if (company.ai.provider === 'mock')
      throw new PublicError('Select and save a provider model first.');
    const key = await providerKey(repo, company);
    const fingerprint = modelFingerprint(company, key);
    const conversation = createConversation(
      company.id,
      `model-test-${randomUUID()}`,
      'demo',
      new Date().toISOString(),
    );
    await new AiModelAdapter(repo).interpret(
      configuredCompany(company),
      await repo.listProducts(company.id),
      conversation,
      'Hello. Please show the menu.',
    );
    const latest = (await repo.getCompany(company.id))!;
    if (fingerprint !== modelFingerprint(latest, await providerKey(repo, latest)))
      throw new PublicError('Model settings changed during the test. Test again.', 409);
    latest.modelVerification = { fingerprint, checkedAt: new Date().toISOString() };
    await repo.saveCompany(latest);
    await repo.audit(company.id, c.get('userId'), 'model.test_passed');
    return c.json({
      ok: true,
      model: company.ai.model,
      checkedAt: latest.modelVerification.checkedAt,
    });
  });
  app.put('/bot/draft', async (c) => {
    owner(c.get('role'));
    const { config, revision } = z
      .object({ config: botSchema, revision: z.number().int().min(0) })
      .parse(await c.req.json());
    const company = c.get('company');
    const settings: BotSettings = {
      ...company.bot,
      draft: config,
      history: company.bot?.history ?? [],
      revision: revision + 1,
    };
    if (!(await repo.saveBot(company.id, settings, revision)))
      throw new PublicError('Another person changed the bot settings. Reload before saving.', 409);
    await repo.audit(company.id, c.get('userId'), 'bot.draft_saved');
    return c.json(settings);
  });
  // Publishes the saved draft, a restored version, or (one click: "Save and publish") the
  // settings on screen, saving them as the draft in the same atomic, revision-guarded write.
  app.post('/bot/publish', async (c) => {
    owner(c.get('role'));
    const { revision, restoreVersion, config } = z
      .object({
        revision: z.number().int().min(0),
        restoreVersion: z.number().int().optional(),
        config: botSchema.optional(),
      })
      .parse(await c.req.json());
    if (restoreVersion && config)
      throw new PublicError('Publish either the current settings or a saved version, not both.');
    const company = c.get('company');
    const previous = company.bot;
    const source = restoreVersion
      ? previous?.history.find((v) => v.version === restoreVersion)?.config
      : (config ?? previous?.draft ?? defaultBot);
    if (!source) throw new PublicError('That saved version is no longer available.', 404);
    const published = {
      version: (previous?.published?.version ?? 0) + 1,
      config: botSchema.parse(source),
      publishedAt: new Date().toISOString(),
      publishedBy: c.get('userId'),
    };
    const settings: BotSettings = {
      draft: published.config,
      published,
      history: [...(previous?.history ?? []), published].slice(-10),
      revision: revision + 1,
    };
    if (!(await repo.saveBot(company.id, settings, revision)))
      throw new PublicError('Bot settings changed. Reload before publishing.', 409);
    await repo.audit(company.id, c.get('userId'), `bot.published_v${published.version}`);
    return c.json(settings);
  });
  app.post('/orders/:id/call', async (c) => {
    const body = z
      .object({
        outcome: z.enum(['confirmed', 'unreachable', 'declined']),
        addressVerified: z.boolean(),
        note: z.string().trim().max(500).default(''),
      })
      .parse(await c.req.json());
    const order = await repo.recordCall(c.get('company').id, c.req.param('id'), {
      ...body,
      at: new Date().toISOString(),
      actorId: c.get('userId'),
    });
    if (!order) throw new PublicError('Only a pending order can receive a call confirmation.', 409);
    await repo.audit(order.companyId, c.get('userId'), `order.call_${body.outcome}`);
    return c.json(order);
  });
  app.delete('/integrations/:kind', async (c) => {
    owner(c.get('role'));
    const kind = z
      .enum(['whatsapp', 'sheets', 'openai', 'gemini', 'anthropic'])
      .parse(c.req.param('kind'));
    const gatewayCleanupPending =
      kind === 'whatsapp' &&
      !!(await disconnectGateway(repo, c.get('company').id)).gatewayCleanupPending;
    await repo.disconnectIntegration(c.get('company').id, kind);
    await repo.audit(c.get('company').id, c.get('userId'), `integration.${kind}.disconnected`);
    return c.json({
      ok: true,
      providerRevocationRequired: true,
      ...(gatewayCleanupPending && { gatewayCleanupPending }),
    });
  });
  app.get('/team', async (c) => {
    owner(c.get('role'));
    const members = await repo.listMembers(c.get('company').id);
    // Emails only, never sign-in times: those are account-wide and would show activity in
    // other businesses. The platform admin's email is never shown to owners.
    const admins = new Set(await repo.listAdminIds());
    const accounts = await repo
      .getAccounts(members.filter((m) => !admins.has(m.userId)).map((m) => m.userId))
      .catch(() => {
        console.warn('Orderly: team emails unavailable.');
        return [] as Account[];
      });
    const byId = new Map(accounts.map((a) => [a.userId, a]));
    c.header('Cache-Control', 'no-store');
    return c.json(
      members.map((m): TeamMember => ({
        userId: m.userId,
        role: m.role,
        email: byId.get(m.userId)?.email,
        waiting: byId.has(m.userId) ? !byId.get(m.userId)!.lastSignInAt : undefined,
        you: m.userId === c.get('userId'),
      })),
    );
  });
  app.post('/team/invite', async (c) => {
    owner(c.get('role'));
    const { email, role } = z
      .object({
        email: z.string().trim().pipe(z.email().max(254)),
        role: z.enum(['owner', 'staff']),
      })
      .parse(await c.req.json());
    // Before any lookup, to slow down checking which emails have accounts.
    if (!(await repo.consumeRateLimit(`invite:${c.get('userId')}`, 5)))
      throw new PublicError('Please wait before sending another invitation.', 429);
    const r = await addMemberByEmail(repo, c.get('company').id, email, role, c.get('userId'));
    await repo.audit(
      c.get('company').id,
      c.get('userId'),
      r.outcome === 'invited' ? 'team.invited' : 'team.member_added',
    );
    return c.json({ ok: true, outcome: r.outcome });
  });
  app.put('/team/:userId', async (c) => {
    owner(c.get('role'));
    const userId = z.string().uuid().parse(c.req.param('userId'));
    const { role } = z.object({ role: z.enum(['owner', 'staff']) }).parse(await c.req.json());
    // Dashboards opened before add-by-email still add people by account ID here.
    if (await repo.isAdmin(userId))
      throw new PublicError(
        'This is the Orderly admin. They can already open every business.',
        409,
      );
    await repo.setMember(c.get('company').id, { userId, role }, c.get('userId'));
    await repo.audit(c.get('company').id, c.get('userId'), `team.role_${role}`);
    return c.json({ ok: true });
  });
  app.delete('/team/:userId', async (c) => {
    owner(c.get('role'));
    const userId = z.string().uuid().parse(c.req.param('userId'));
    await repo.removeMember(c.get('company').id, userId, c.get('userId'));
    await repo.audit(c.get('company').id, c.get('userId'), 'team.member_removed');
    return c.json({ ok: true });
  });
  // A number as owners type it ('0300 1234567', '+92 300 1234567') and the forms it is stored
  // in: digits from Meta (923001234567), +digits from the linked phone, or exactly as typed.
  const phoneForms = (typed: string) => {
    const raw = typed.trim();
    const digits = normalizeTypedPhone(raw);
    return { raw, stored: digits ? [digits, `+${digits}`] : [] };
  };
  const NO_RECORDS =
    'No records found for this number. Copy the number exactly as shown in the Inbox.';
  const NO_CHAT = 'No records found for this chat. It may have been deleted already.';
  // A customer is named by their number or, for a chat where WhatsApp never shared the number
  // (a privacy ID), by one of their chats: exactly one of the two.
  const conversationIdSchema = z.string().trim().min(1).max(200);
  const oneCustomer = (phone: unknown, conversationId: unknown) => {
    if ((phone === undefined) === (conversationId === undefined))
      throw new PublicError(
        'Give the customer’s number or one of their chats (one of the two).',
        400,
      );
  };
  app.get('/privacy/customer', async (c) => {
    owner(c.get('role'));
    const companyId = c.get('company').id;
    oneCustomer(c.req.query('phone'), c.req.query('conversationId'));
    const conversationId =
      c.req.query('conversationId') === undefined
        ? undefined
        : conversationIdSchema.parse(c.req.query('conversationId'));
    // Every chat erasing this customer would remove (not only the newest per channel), and
    // their orders.
    const found = new Map<string, Conversation>();
    const matched = new Map<string, Order>();
    let forms: string[];
    if (conversationId) {
      const records = await repo.conversationRecords(companyId, conversationId);
      const chat = records.conversations.find((r) => r.id === conversationId);
      if (!chat) throw new PublicError(NO_CHAT, 404);
      for (const conversation of records.conversations) found.set(conversation.id, conversation);
      for (const order of records.orders) matched.set(order.id, order);
      // The chat's number, when known, also finds orders placed under it (below).
      const phone = chat.customerPhone.trim();
      forms = phone ? [...new Set([...phoneForms(phone).stored, phone])] : [];
    } else {
      const { raw, stored } = phoneForms(z.string().min(4).max(80).parse(c.req.query('phone')));
      forms = [...new Set([...stored, raw])];
      for (const phone of forms) {
        const records = await repo.customerRecords(companyId, phone);
        for (const conversation of records.conversations) found.set(conversation.id, conversation);
        for (const order of records.orders) matched.set(order.id, order);
      }
    }
    const conversations = [...found.values()];
    for (const phone of forms)
      for (let page = 1; ; page++) {
        const result = await repo.queryOrders(companyId, { search: phone, page, pageSize: 100 });
        for (const order of result.items)
          if (forms.includes(order.customerPhone)) matched.set(order.id, order);
        if (page * 100 >= result.total) break;
        if (page >= 100)
          throw new PublicError('Large export: contact support for a complete archive.', 413);
      }
    const orders = [...matched.values()];
    // An empty file would read as "we hold nothing", when the number may just be typed
    // differently from how it is stored.
    if (!conversations.length && !orders.length) throw new PublicError(NO_RECORDS, 404);
    for (const conversation of conversations) {
      conversation.messages = [];
      for (let page = 1; ; page++) {
        const result = await repo.conversationHistory(
          conversation.companyId,
          conversation.id,
          page,
        );
        conversation.messages.unshift(...result.items.reverse());
        if (page * 100 >= result.total) break;
        if (page >= 100)
          throw new PublicError('Large export: contact support for a complete archive.', 413);
      }
    }
    await repo.audit(c.get('company').id, c.get('userId'), 'privacy.customer_exported');
    return c.json({ exportedAt: new Date().toISOString(), conversations, orders });
  });
  app.post('/privacy/erase', async (c) => {
    owner(c.get('role'));
    const { phone, conversationId } = z
      .object({
        phone: z.string().trim().min(4).max(80).optional(),
        conversationId: conversationIdSchema.optional(),
        externalCopiesAcknowledged: z.literal(true),
      })
      .parse(await c.req.json());
    oneCustomer(phone, conversationId);
    const companyId = c.get('company').id;
    let deleted = 0;
    if (conversationId) {
      // The chat, every other chat with its number, and every chat with its privacy ID.
      deleted = await repo.eraseConversation(companyId, conversationId);
    } else {
      // The number's digits first (the database matches every stored form of them), then
      // +digits for a database that still matches exact text, and the number as typed only if
      // neither found anything.
      const { raw, stored } = phoneForms(phone!);
      for (const form of stored) deleted += await repo.eraseCustomer(companyId, form);
      if (!deleted && !stored.includes(raw)) deleted += await repo.eraseCustomer(companyId, raw);
    }
    // The count shows afterwards whether a request really removed anything.
    await repo.audit(companyId, c.get('userId'), `privacy.customer_erased.${deleted}`);
    if (!deleted) throw new PublicError(conversationId ? NO_CHAT : NO_RECORDS, 404);
    return c.json({ deleted });
  });
  // The public menu page: anyone on the team sees it, owners switch it on or off.
  app.get('/menu-link', async (c) => c.json(await menuLinkStatus(repo, c.get('company'))));
  app.put('/menu-link', async (c) => {
    owner(c.get('role'));
    const { enabled } = z
      .object({ enabled: z.boolean() })
      .strict()
      .parse(await c.req.json());
    const company = c.get('company');
    if (enabled && !(await whatsappNumberFor(repo, company.id).catch(() => undefined)))
      await refreshDisplayNumber(repo, company.id);
    await repo.setMenuLink(company.id, enabled, baseSlug(company));
    return c.json(await menuLinkStatus(repo, company));
  });
  return app;
}
