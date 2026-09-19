import { randomUUID } from 'node:crypto';
import type { Repository } from './repository.js';
import type {
  BotAction,
  Company,
  Conversation,
  IntegrationKind,
  Order,
  TurnInput,
} from '../src/shared/types.js';
import {
  createConversation,
  parseActions,
  processTurn,
  transitionOrder,
} from '../src/domain/engine.js';
import { AiModelAdapter, providerKey } from './integrations/models.js';
import { modelFingerprint } from './integrations/model-catalog.js';
import { GoogleSheetsAdapter } from './integrations/sheets.js';
import { WhatsAppAdapter } from './integrations/whatsapp.js';
import { decryptSecret, PublicError } from './security.js';
import { sanitizeError } from './security.js';
import { botConfig, configuredCompany } from '../src/shared/bot.js';
import { dispatchJob, makeJob } from './jobs.js';
import { sendStaffAlert } from './integrations/alerts.js';

// Paid Supabase workers have a 400s maximum lifetime. Include an 80s margin;
// bounded upstream requests and database requests cannot survive this lease.
export const WORKER_LEASE_MS = 480000;

export async function integrationAdapter(
  repo: Repository,
  companyId: string,
  kind: 'sheets',
): Promise<GoogleSheetsAdapter>;
export async function integrationAdapter(
  repo: Repository,
  companyId: string,
  kind: 'whatsapp',
): Promise<WhatsAppAdapter>;
export async function integrationAdapter(
  repo: Repository,
  companyId: string,
  kind: 'sheets' | 'whatsapp',
) {
  const integration = (await repo.getIntegrations(companyId)).find((i) => i.kind === kind);
  const secret = await repo.getSecret(companyId, kind);
  if (!integration || !secret)
    throw new PublicError(
      `Connect ${kind === 'sheets' ? 'Google Sheets' : 'WhatsApp'} first.`,
      409,
    );
  return kind === 'sheets'
    ? new GoogleSheetsAdapter(integration, decryptSecret(secret))
    : new WhatsAppAdapter(integration, decryptSecret(secret));
}
export async function refreshCatalog(repo: Repository, company: Company): Promise<number> {
  const adapter = await integrationAdapter(repo, company.id, 'sheets');
  const products = await adapter.readCatalog(company.id);
  await repo.replaceProducts(company.id, products);
  // Re-read company to avoid reverting concurrent business settings edits.
  const latest = await repo.getCompany(company.id);
  if (!latest) throw new PublicError('Company not found.', 404);
  await repo.saveCompany({ ...latest, catalogSyncedAt: new Date().toISOString() });
  return products.length;
}
export async function handleTurn(
  repo: Repository,
  company: Company,
  conversation: Conversation,
  input: TurnInput,
) {
  const sandbox = conversation.channel === 'demo';
  const selectConfig = (value: Company): Company => {
    if (!sandbox) return configuredCompany(value);
    if (input.testTarget === 'published' && !value.bot?.published)
      throw new PublicError(
        'Publish a bot configuration before testing the published version.',
        409,
      );
    const useDraft = input.testTarget !== 'published';
    const selected = botConfig(value, useDraft);
    const preview = {
      ...value,
      botEnabled: true,
      bot: {
        draft: selected,
        history: [],
        revision: value.bot?.revision ?? 0,
        published: {
          version: useDraft ? 0 : (value.bot?.published?.version ?? 0),
          config: selected,
          publishedAt: input.now,
          publishedBy: 'sandbox',
        },
      },
    };
    return configuredCompany(preview);
  };
  const lockId = randomUUID();
  if (
    !(await repo.acquireConversationLock(
      company.id,
      conversation.id,
      lockId,
      new Date(Date.now() + WORKER_LEASE_MS).toISOString(),
    ))
  )
    throw new PublicError(
      'The previous message is still processing. Please try again in a moment.',
      409,
    );
  try {
    company = selectConfig((await repo.getCompany(company.id)) ?? company);
    const storedConversation = await repo.getConversation(company.id, conversation.id);
    if (!storedConversation && conversation.version > 0)
      throw new PublicError('This conversation was deleted. Start a new conversation.', 409);
    conversation = storedConversation ?? conversation;
    if (sandbox && storedConversation?.testContext) {
      const expected = {
        target: input.testTarget ?? 'draft',
        configRevision:
          input.testTarget === 'published'
            ? (company.bot?.published?.version ?? 0)
            : (company.bot?.revision ?? 0),
        provider: company.ai.provider,
        model: company.ai.model,
        keyMode: company.ai.keyMode,
        catalogSource: company.catalogSource,
      };
      if (JSON.stringify(storedConversation.testContext) !== JSON.stringify(expected))
        throw new PublicError(
          'The tested bot configuration changed. Start a new test conversation.',
          409,
        );
    }
    if (conversation.messages.some((m) => m.id === input.messageId))
      return {
        conversation,
        reply: conversation.messages.filter((m) => m.role === 'assistant').at(-1)?.text ?? '',
        traces: ['duplicate_message_ignored'],
      };
    if (
      company.botEnabled &&
      conversation.mode === 'bot' &&
      conversation.messages.filter(
        (m) => m.role === 'customer' && Date.now() - Date.parse(m.createdAt) < 60000,
      ).length >= 15
    )
      return await saveHandoff(
        repo,
        company,
        conversation,
        input,
        'There are several messages arriving at once. A staff member will help with your order.',
      );
    // A sheet-backed catalog is refreshed before any potentially mutating bot turn.
    if (
      company.catalogSource === 'sheets' &&
      conversation.mode === 'bot' &&
      company.botEnabled &&
      (!company.catalogSyncedAt || Date.now() - Date.parse(company.catalogSyncedAt) > 60000)
    ) {
      try {
        await refreshCatalog(repo, company);
      } catch (error) {
        if (sandbox)
          throw new PublicError(
            `Could not refresh the connected menu Sheet: ${sanitizeError(error)}`,
            503,
          );
        return await saveHandoff(
          repo,
          company,
          conversation,
          input,
          'The menu connection needs attention. A staff member will help you complete your order.',
          error,
        );
      }
    }
    const products = await repo.listProducts(company.id);
    let actions: BotAction[] | undefined;
    let modelResponse: import('../src/shared/types.js').ModelResponse | undefined;
    const submittedCancellation =
      Boolean(conversation.cart.orderId) &&
      /^(cancel|cancel order|منسوخ|order cancel)$/i.test(input.text.trim());
    if (sandbox && !input.action && company.ai.provider === 'mock' && !submittedCancellation)
      throw new PublicError(
        'Connect and select an AI model in Bot settings before testing customer messages.',
        409,
      );
    if (sandbox && !input.action && company.ai.provider !== 'mock' && !submittedCancellation) {
      const key = await providerKey(repo, company);
      if (company.modelVerification?.fingerprint !== modelFingerprint(company, key))
        throw new PublicError(
          'Run the selected model generation test in Bot settings before testing conversations.',
          409,
        );
    }
    const deterministic = !input.action
      ? parseActions(company, products, conversation, input.text)
      : undefined;
    if (
      !input.action &&
      (conversation.pendingItemChoice || deterministic?.[0]?.type === 'clarify_item')
    )
      actions = deterministic;
    if (
      !input.action &&
      !actions &&
      !submittedCancellation &&
      company.ai.provider !== 'mock' &&
      conversation.mode === 'bot' &&
      company.botEnabled
    ) {
      try {
        const interpretation = await new AiModelAdapter(repo).interpret(
          company,
          products,
          conversation,
          input.text,
        );
        const matchedRule = botConfig(company).behaviorRules.find(
          (rule) => rule.enabled && rule.id === interpretation.response?.matchedRuleId,
        );
        actions =
          matchedRule?.action === 'handoff'
            ? [{ type: 'handoff' }]
            : matchedRule?.action === 'reply'
              ? [{ type: 'answer', text: interpretation.response?.text ?? matchedRule.response }]
              : interpretation.actions;
        modelResponse = interpretation.response;
      } catch (error) {
        if (sandbox)
          throw error instanceof PublicError ? error : new PublicError(sanitizeError(error), 503);
        return await saveHandoff(
          repo,
          company,
          conversation,
          input,
          'I’m having trouble connecting right now. A staff member will help you; your order has not been submitted.',
          error,
        );
      }
    }
    // A settings change during a slow model call takes effect before this turn acts.
    company = selectConfig((await repo.getCompany(company.id)) ?? company);
    // For a submitted order, cancel only while it is still awaiting staff acceptance.
    if (
      conversation.mode === 'bot' &&
      company.botEnabled &&
      conversation.cart.orderId &&
      (input.action?.type === 'cancel' ||
        /^(cancel|cancel order|منسوخ|order cancel)$/i.test(input.text.trim()))
    ) {
      const order = await repo.getOrder(company.id, conversation.cart.orderId);
      if (order?.status === 'pending') {
        const c = structuredClone(conversation);
        c.cart.status = 'cancelled';
        c.version++;
        c.updatedAt = input.now;
        c.lastInboundAt = new Date(
          Math.max(Date.parse(c.lastInboundAt), Date.parse(input.now)),
        ).toISOString();
        const reply = `Order ${order.reference} has been cancelled.`;
        c.messages.push(
          {
            id: input.messageId,
            role: 'customer',
            text: input.text || 'Cancel order',
            createdAt: input.now,
          },
          { id: randomUUID(), role: 'assistant', text: reply, createdAt: input.now },
        );
        const cancelled = await changeOrderStatus(repo, order, 'cancelled', input.now, c);
        return { conversation: c, order: cancelled, reply, traces: ['order_cancelled'] };
      }
    }
    const result = processTurn(company, products, conversation, input, actions, modelResponse);
    result.conversation.lastInboundAt = new Date(
      Math.max(Date.parse(conversation.lastInboundAt), Date.parse(input.now)),
    ).toISOString();
    result.conversation.version = conversation.version + 1;
    const integrations = await repo.getIntegrations(company.id);
    const sheetsConnected =
      !sandbox && integrations.some((i) => i.kind === 'sheets' && i.configured);
    if (result.order) result.order.syncStatus = sheetsConnected ? 'pending' : 'not_connected';
    const jobs = [];
    if (result.order && sheetsConnected)
      jobs.push(makeJob(company.id, 'sheet_sync', { orderId: result.order.id }));
    if (result.reply && conversation.channel === 'whatsapp')
      jobs.push(
        makeJob(company.id, 'whatsapp_send', {
          conversationId: conversation.id,
          messageId: result.conversation.messages.at(-1)?.id,
          text: result.reply,
          cartRevision: result.conversation.cart.revision,
          source: result.conversation.mode === 'human' ? 'notice' : 'bot',
        }),
      );
    if (
      !(await repo.commitTurn(
        company.id,
        result.conversation,
        conversation.version,
        result.order,
        jobs,
      ))
    )
      throw new PublicError(
        'The conversation changed while processing. Please retry your message.',
        409,
      );
    for (const action of result.traces)
      await repo.addTrace({
        id: randomUUID(),
        companyId: company.id,
        conversationId: conversation.id,
        action,
        detail: action.replaceAll('_', ' '),
        createdAt: input.now,
        model: company.ai.model,
        botVersion: company.bot?.published?.version,
      });
    for (const job of jobs) await dispatchJob(repo, job);
    return result;
  } finally {
    await repo.releaseConversationLock(company.id, conversation.id, lockId);
  }
}
async function saveHandoff(
  repo: Repository,
  company: Company,
  conversation: Conversation,
  input: TurnInput,
  reply: string,
  reason?: unknown,
) {
  const c = structuredClone(conversation);
  c.mode = 'human';
  c.version++;
  c.updatedAt = input.now;
  c.lastInboundAt = new Date(
    Math.max(Date.parse(c.lastInboundAt), Date.parse(input.now)),
  ).toISOString();
  c.messages.push(
    { id: input.messageId, role: 'customer', text: input.text, createdAt: input.now },
    { id: randomUUID(), role: 'assistant', text: reply, createdAt: input.now },
  );
  const jobs =
    c.channel === 'whatsapp'
      ? [
          makeJob(company.id, 'whatsapp_send', {
            conversationId: c.id,
            messageId: c.messages.at(-1)?.id,
            text: reply,
            source: 'notice',
          }),
        ]
      : [];
  if (!(await repo.commitTurn(company.id, c, conversation.version, undefined, jobs)))
    throw new PublicError('Conversation changed. Retry your message.', 409);
  await repo.addTrace({
    id: randomUUID(),
    companyId: company.id,
    conversationId: c.id,
    action: 'staff_attention',
    detail: reason ? sanitizeError(reason) : reply,
    code:
      reason instanceof PublicError && reason.status === 429
        ? 'budget_or_rate_limit'
        : 'connection_failure',
    model: company.ai.model,
    botVersion: company.bot?.published?.version,
    createdAt: input.now,
  });
  for (const job of jobs) await dispatchJob(repo, job);
  return { conversation: c, reply, traces: ['staff_attention'] };
}
export async function queueOrderSync(repo: Repository, order: Order) {
  if (
    order.sandbox ||
    (await repo.getConversation(order.companyId, order.conversationId))?.channel !== 'whatsapp'
  )
    return;
  const connected = (await repo.getIntegrations(order.companyId)).some(
    (i) => i.kind === 'sheets' && i.configured,
  );
  if (!connected) return;
  await repo.setOrderSyncStatus(order.companyId, order.id, 'pending');
  const job = makeJob(order.companyId, 'sheet_sync', { orderId: order.id });
  await repo.insertJob(job);
  await dispatchJob(repo, job);
}
export async function changeOrderStatus(
  repo: Repository,
  order: Order,
  status: Order['status'],
  now = new Date().toISOString(),
  automatedConversation?: Conversation,
): Promise<Order> {
  if (order.status === status) return order;
  transitionOrder(order, status, now);
  const conversation = await repo.getConversation(order.companyId, order.conversationId);
  if (
    status === 'accepted' &&
    order.phoneConfirmationRequired &&
    (order.phoneConfirmation?.outcome !== 'confirmed' ||
      (order.fulfillment === 'delivery' && !order.phoneConfirmation.addressVerified))
  )
    throw new PublicError(
      'Record a confirmed customer call and verify the delivery address before accepting.',
      409,
    );
  const connected = (await repo.getIntegrations(order.companyId)).some(
    (i) => i.kind === 'sheets' && i.configured,
  );
  const jobs = [];
  if (connected && !order.sandbox && conversation?.channel === 'whatsapp')
    jobs.push(makeJob(order.companyId, 'sheet_sync', { orderId: order.id }));
  if (conversation?.channel === 'whatsapp')
    jobs.push(
      makeJob(order.companyId, 'whatsapp_send', {
        conversationId: conversation.id,
        text: `Order ${order.reference} is now ${status.replaceAll('_', ' ')}.`,
        orderId: order.id,
        reference: order.reference,
        status,
        source: 'notice',
      }),
    );
  const updated = await repo.updateOrderStatus(
    order.companyId,
    order.id,
    order.status,
    status,
    now,
    jobs,
    automatedConversation,
  );
  if (!updated)
    throw new PublicError('Another staff member changed this order. Refresh and try again.', 409);
  for (const job of jobs) await dispatchJob(repo, job);
  return updated;
}
export async function queueReply(
  repo: Repository,
  conversation: Conversation,
  text: string,
  order?: Order,
) {
  if (conversation.channel !== 'whatsapp') return;
  const job = makeJob(conversation.companyId, 'whatsapp_send', {
    conversationId: conversation.id,
    text,
    ...(order ? { orderId: order.id, reference: order.reference, status: order.status } : {}),
  });
  await repo.insertJob(job);
  await dispatchJob(repo, job);
}
export async function processJob(repo: Repository, id: string) {
  const job = await repo.claimJob(
    id,
    new Date().toISOString(),
    new Date(Date.now() + WORKER_LEASE_MS).toISOString(),
  );
  if (!job) return;
  try {
    if (job.attempts > 5)
      throw new PublicError('Repeated worker interruptions require staff review.', 503);
    const company = await repo.getCompany(job.companyId);
    if (!company) throw new PublicError('Job company no longer exists.', 404);
    if (job.kind === 'incoming') {
      const phone = String(job.payload.phone);
      const existing = await repo.findConversation(company.id, phone, 'whatsapp');
      const conversation = existing ?? {
        ...createConversation(company.id, phone, 'whatsapp', '1970-01-01T00:00:00.000Z'),
        updatedAt: job.createdAt,
        lastInboundAt: job.createdAt,
      };
      if (job.payload.echo) {
        if (
          !(await repo.acquireConversationLock(
            company.id,
            conversation.id,
            job.id,
            new Date(Date.now() + WORKER_LEASE_MS).toISOString(),
          ))
        )
          throw new PublicError('Conversation is busy.', 409);
        try {
          const current = (await repo.getConversation(company.id, conversation.id)) ?? {
            ...conversation,
            lastInboundAt: '1970-01-01T00:00:00.000Z',
          };
          if (!current.messages.some((m) => m.id === job.payload.messageId)) {
            const next = {
              ...current,
              mode: 'human' as const,
              version: current.version + 1,
              updatedAt: job.createdAt,
              messages: [
                ...current.messages,
                {
                  id: String(job.payload.messageId),
                  role: 'staff' as const,
                  text: String(job.payload.text),
                  createdAt: job.createdAt,
                },
              ],
            };
            if (!(await repo.saveConversation(next, current.version)))
              throw new PublicError('Conversation changed. Retry the echo.', 409);
          }
        } finally {
          await repo.releaseConversationLock(company.id, conversation.id, job.id);
        }
      } else
        await handleTurn(repo, company, conversation, {
          messageId: String(job.payload.messageId),
          text: String(job.payload.text),
          action:
            Date.now() - Date.parse(job.createdAt) > 10 * 60 * 1000
              ? { type: 'handoff' }
              : (job.payload.action as BotAction | undefined),
          now: job.createdAt,
        });
    } else if (job.kind === 'staff_alert') {
      await sendStaffAlert(repo, job);
    } else if (job.kind === 'sheet_sync') {
      const sheetLock = `sheet:${company.id}`;
      if (
        !(await repo.acquireConversationLock(
          company.id,
          sheetLock,
          job.id,
          new Date(Date.now() + WORKER_LEASE_MS).toISOString(),
        ))
      )
        throw new PublicError('Another spreadsheet write is running.', 409);
      try {
        const order = await repo.getOrder(company.id, String(job.payload.orderId));
        if (!order) throw new PublicError('Order not found.', 404);
        if (
          order.sandbox ||
          (await repo.getConversation(company.id, order.conversationId))?.channel !== 'whatsapp'
        ) {
          await repo.saveJob({ ...job, status: 'done', leaseUntil: undefined });
          return;
        }
        await (await integrationAdapter(repo, company.id, 'sheets')).syncOrder(order);
        await repo.setOrderSyncStatus(company.id, order.id, 'synced', order.updatedAt);
      } finally {
        await repo.releaseConversationLock(company.id, sheetLock, job.id);
      }
    } else {
      const conversation = await repo.getConversation(
        company.id,
        String(job.payload.conversationId),
      );
      if (!conversation) throw new PublicError('Conversation not found.', 404);
      if (job.payload.source === 'bot' && (!company.botEnabled || conversation.mode === 'human')) {
        await repo.saveJob({ ...job, status: 'done', leaseUntil: undefined, error: undefined });
        return;
      }
      const adapter = await integrationAdapter(repo, company.id, 'whatsapp');
      const statusOrder = job.payload.orderId
        ? await repo.getOrder(company.id, String(job.payload.orderId))
        : undefined;
      // A delayed acceptance notification must not follow a newer cancellation.
      if (statusOrder && job.payload.status !== statusOrder.status) {
        await repo.saveJob({ ...job, status: 'done', leaseUntil: undefined, error: undefined });
        return;
      }
      let messageId: string;
      if (typeof job.payload.externalId === 'string') messageId = job.payload.externalId;
      else if (
        Date.now() - Date.parse(conversation.lastInboundAt) >= 86400000 &&
        job.payload.reference
      )
        messageId = await adapter.sendStatusTemplate(
          conversation,
          String(job.payload.reference),
          String(job.payload.status),
        );
      else {
        const snapshot = structuredClone(conversation);
        // Never attach a new cart's confirmation to an older queued response.
        if (job.payload.cartRevision !== conversation.cart.revision)
          snapshot.cart.status = 'building';
        messageId = await adapter.send(snapshot, String(job.payload.text));
      }
      // Checkpoint the provider receipt before bookkeeping. Retrying this job
      // reuses the receipt instead of sending the same message again.
      job.payload.externalId = messageId;
      await repo.saveJob(job);
      await repo.recordDelivery(
        company.id,
        messageId,
        'accepted',
        conversation.id,
        typeof job.payload.messageId === 'string' ? job.payload.messageId : undefined,
      );
      await repo.addTrace({
        id: randomUUID(),
        companyId: company.id,
        conversationId: conversation.id,
        action: 'whatsapp.accepted',
        detail: `Message accepted by Meta: ${messageId}`,
        createdAt: new Date().toISOString(),
      });
    }
    await repo.saveJob({ ...job, status: 'done', leaseUntil: undefined, error: undefined });
  } catch (error) {
    const permanent = job.attempts >= 5;
    await repo.saveJob({
      ...job,
      status: permanent ? 'failed' : 'pending',
      leaseUntil: undefined,
      nextRunAt: new Date(Date.now() + Math.min(3600000, 2 ** job.attempts * 5000)).toISOString(),
      error:
        error instanceof PublicError
          ? error.message
          : 'Integration failed; check its credentials and service health.',
    });
    if (job.kind === 'sheet_sync') {
      await repo.setOrderSyncStatus(job.companyId, String(job.payload.orderId), 'failed');
    }
    // A failed incoming message remains a FIFO barrier until recovery. Mark its
    // conversation for staff too, so retrying the stream cannot resume ordering silently.
    let failedConversationId: string | undefined;
    if (permanent && job.kind === 'incoming') {
      const current = await repo.findConversation(
        job.companyId,
        String(job.payload.phone),
        'whatsapp',
      );
      if (current) {
        failedConversationId = current.id;
        if (current.mode === 'bot')
          await repo.saveConversation(
            {
              ...current,
              mode: 'human',
              version: current.version + 1,
              updatedAt: new Date().toISOString(),
            },
            current.version,
          );
      }
    }
    await repo.addTrace({
      id: randomUUID(),
      companyId: job.companyId,
      ...(failedConversationId ? { conversationId: failedConversationId } : {}),
      action: permanent ? 'job.failed' : 'job.retry',
      detail:
        error instanceof PublicError ? error.message : 'Background job failed and will retry.',
      createdAt: new Date().toISOString(),
    });
    if (!permanent) throw new PublicError('Background job is waiting to retry.', 503);
  }
}
