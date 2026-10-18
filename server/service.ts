import { randomUUID } from 'node:crypto';
import type { Repository } from './repository.js';
import type {
  BotAction,
  Cart,
  Company,
  Conversation,
  IntegrationKind,
  Language,
  ModelInterpretation,
  ModelSkipReason,
  Job,
  Order,
  StaffNoticeCause,
  TurnInput,
  TurnResult,
} from '../src/shared/types.js';
import { attachExplanation, describeTurn } from './explanations.js';
import {
  aiErrorNotice,
  asksForPerson,
  asksOrderStatus,
  asksToCancelOrder,
  createConversation,
  emptyCart,
  limitNotice,
  limitPaused,
  noticeLanguage,
  orderSafetyLine,
  orderStatusText,
  processTurn,
  resumesAfterLimit,
  resumesAfterPause,
  transitionOrder,
} from '../src/domain/engine.js';
import { isStaffRequest, withDisclosure } from '../src/domain/disclosure.js';
import {
  AiCallError,
  AiLimitError,
  AiModelAdapter,
  providerKey,
  StoreUnavailableError,
} from './integrations/models.js';
import {
  AI_ERROR_PAUSE_MS,
  BURST_PAUSE_MS,
  CUSTOMER_LIMIT_PAUSE_MS,
  effectiveAiLimits,
  LIMIT_NOTICE_INTERVAL_MS,
} from '../src/shared/models.js';
import { modelFingerprint } from './integrations/model-catalog.js';
import { GoogleSheetsAdapter } from './integrations/sheets.js';
import { WhatsAppAdapter } from './integrations/whatsapp.js';
import { decryptSecret, PublicError } from './security.js';
import { sanitizeError } from './security.js';
import { botConfig, configuredCompany } from '../src/shared/bot.js';
import { dispatchJob, makeJob } from './jobs.js';
import { automationPaused, workerLeaseMs } from './config.js';
import { sendStaffAlert } from './integrations/alerts.js';
import { LinkedWhatsAppAdapter } from './integrations/linked-whatsapp';
import { assertCurrentAddress, jobAddress, requireMeta } from './whatsapp/connections';
import { customerKeys, sameAddress, type WhatsAppAddress } from '../src/shared/whatsapp';
import { appHost, menuPublicUrl, personalMenuText, redeemMenuDraft } from './menu.js';
import { menuCodeIn } from '../src/shared/menu.js';

// A message handled more than this late is answered with care: a confirmation is asked again.
const LATE_AFTER_MS = 10 * 60 * 1000;
// A message this late is not answered by the bot at all: staff look at it, and the bot takes the
// chat back on the customer's next message (unless staff wrote).
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;
// While the menu Sheet cannot be read, the menu last read from it is used for this long.
export const MENU_STALE_LIMIT_MS = 12 * 60 * 60 * 1000;

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
  if (kind === 'whatsapp') await requireMeta(repo, companyId);
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
  // Only this one field is written: re-saving the whole company could undo a concurrent
  // settings change, such as the bot being switched off. Best effort: the menu is already
  // refreshed, and a missed stamp only means the next turn reads the Sheet again.
  await repo.markCatalogSynced(company.id, new Date().toISOString()).catch(() => undefined);
  return products.length;
}
const MENU_SYNC_NOTE = 'Menu refresh failed: ';
// The Sheets connection shows why the menu could not be refreshed, until a refresh works again.
// Only the note changes, never the status: a failed refresh must not block saving settings.
async function noteMenuSync(repo: Repository, companyId: string, error?: unknown) {
  const sheets = (await repo.getIntegrations(companyId)).find((i) => i.kind === 'sheets');
  if (!sheets) return;
  const note = error === undefined ? undefined : `${MENU_SYNC_NOTE}${sanitizeError(error)}`;
  if (note === undefined && !sheets.error?.startsWith(MENU_SYNC_NOTE)) return;
  if (note !== undefined && sheets.error === note) return;
  await repo.saveIntegration(companyId, {
    ...sheets,
    error: note,
    ...(note && { checkedAt: new Date().toISOString() }),
  });
}
/**
 * Refreshes a Sheet menu, at most one attempt a minute for the business however many chats
 * arrive. A failure never throws: the menu stored from the Sheet stays in use while its last
 * good refresh is under 12 hours old (`usable`), and the problem is shown on the connection.
 */
export async function refreshSheetMenu(
  repo: Repository,
  company: Company,
): Promise<{ ok: true } | { ok: false; usable: boolean; error?: unknown }> {
  const usable = async () => {
    const latest = (await repo.getCompany(company.id).catch(() => undefined)) ?? company;
    const synced = latest.catalogSyncedAt ? Date.parse(latest.catalogSyncedAt) : NaN;
    return (
      Date.now() - synced <= MENU_STALE_LIMIT_MS &&
      (await repo.listProducts(company.id)).some((p) => p.companyId === company.id)
    );
  };
  if (!(await repo.consumeRateLimit(`catalog-refresh:${company.id}`, 1).catch(() => true)))
    return { ok: false, usable: await usable() };
  try {
    await refreshCatalog(repo, company);
  } catch (error) {
    await noteMenuSync(repo, company.id, error).catch(() => undefined);
    const stale = await usable();
    if (stale)
      await repo
        .addTrace({
          id: randomUUID(),
          companyId: company.id,
          action: 'menu_sync_stale',
          detail: `${sanitizeError(error)} The menu last read from the Sheet is still in use.`,
          createdAt: new Date().toISOString(),
        })
        .catch(() => undefined);
    return { ok: false, usable: stale, error };
  }
  await noteMenuSync(repo, company.id).catch(() => undefined);
  return { ok: true };
}
/**
 * `retryable`: the message may be processed again (its job has tries left), so a database that
 * could not be reached before the AI call fails the turn instead of pausing the chat.
 */
export async function handleTurn(
  repo: Repository,
  company: Company,
  conversation: Conversation,
  input: TurnInput,
  options: { retryable?: boolean } = {},
): Promise<TurnResult> {
  const sandbox = conversation.channel === 'demo';
  const selectConfig = (value: Company): Company => {
    if (!sandbox) {
      const configured = configuredCompany(value);
      // The platform-wide stop: every business behaves as if its bot were switched off.
      return automationPaused() ? { ...configured, botEnabled: false } : configured;
    }
    if (automationPaused())
      throw new PublicError(
        'Automatic replies are paused on Orderly right now. Try again later.',
        503,
      );
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
      new Date(Date.now() + workerLeaseMs()).toISOString(),
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
        catalogSource: company.catalogSource,
      };
      const current = storedConversation.testContext;
      if (
        current.target !== expected.target ||
        current.configRevision !== expected.configRevision ||
        current.provider !== expected.provider ||
        current.model !== expected.model ||
        current.catalogSource !== expected.catalogSource
      )
        throw new PublicError(
          'The tested bot configuration changed. Start a new test conversation.',
          409,
        );
    }
    // An order code from the menu page (Instagram/QR) is placed without any AI, but only for a
    // business that has a menu link.
    const menuCode = !sandbox && !input.action ? menuCodeIn(input.text) : undefined;
    const codeUsable = !!menuCode && !!(await repo.getMenuLink(company.id).catch(() => undefined));
    if (conversation.messages.some((m) => m.id === input.messageId))
      return {
        conversation,
        reply: conversation.messages.filter((m) => m.role === 'assistant').at(-1)?.text ?? '',
        traces: ['duplicate_message_ignored'],
      };
    // Hours late (a backlog after an outage): no AI and no answer to an old message. Staff see
    // it, and the bot takes the chat back on the customer's next message unless staff wrote.
    // A backlog never takes a paused chat back either.
    const stale = !!input.late && Date.now() - Date.parse(input.now) > STALE_AFTER_MS;
    // The bot is on again: a chat that went to staff only because it was off goes back.
    // Saved first, because order changes (a cancel) check the stored mode.
    if (!sandbox && !stale && company.botEnabled && resumesAfterPause(conversation)) {
      const resumed: Conversation = {
        ...conversation,
        mode: 'bot',
        botPausedAt: undefined,
        version: conversation.version + 1,
      };
      if (!(await repo.saveConversation(resumed, conversation.version)))
        throw new PublicError(
          'The conversation changed while processing. Please retry your message.',
          409,
        );
      conversation = resumed;
    }
    // A chat an AI limit paused goes back to the bot once the limit resets or is raised. A
    // button or cancelling a submitted order needs no AI, so it goes back straight away; if
    // the limit still applies, the next typed message pauses it again without a new notice
    // and until the same time (the old pause is kept for that, inactive while in bot mode).
    const resetOrRaised = resumesAfterLimit(conversation, company);
    if (
      !sandbox &&
      !stale &&
      company.botEnabled &&
      limitPaused(conversation) &&
      (resetOrRaised ||
        (input.action && input.action.type !== 'handoff') ||
        cancelsSubmittedOrder(conversation, input.text) ||
        codeUsable)
    ) {
      const resumed: Conversation = {
        ...conversation,
        mode: 'bot',
        limitPause: resetOrRaised ? undefined : conversation.limitPause,
        // A customer whose own pause ended starts with a full allowance again.
        ...(resetOrRaised &&
          conversation.limitPause?.reason === 'customer' && {
            limitResumedAt: new Date().toISOString(),
          }),
        version: conversation.version + 1,
      };
      if (!(await repo.saveConversation(resumed, conversation.version)))
        throw new PublicError(
          'The conversation changed while processing. Please retry your message.',
          409,
        );
      conversation = resumed;
    }
    if (stale && company.botEnabled && conversation.mode === 'bot')
      return await savePause(repo, company, conversation, input, {
        reason: 'late',
        until: { afterMs: 0 },
        text: lateNotice,
        skipped: 'late',
        trace: {
          action: 'staff_attention',
          code: 'late',
          detail:
            'This message reached Orderly more than 2 hours late, so staff were asked to look at it. The bot answers the customer’s next message.',
        },
      });
    // One customer sending many messages at once pauses the bot for them only, for a while.
    // The minute is measured by when the messages were sent, not when they are answered: a
    // flood queues up behind slow replies, and counting by answer time would never see it.
    // Either side of this message, since WhatsApp's times are only to the second. Test chats
    // never count (they have their own limit).
    const { messagesPerCustomerPerMinute } = effectiveAiLimits(company.aiLimits);
    const sentAt = Date.parse(input.now);
    if (
      !sandbox &&
      company.botEnabled &&
      conversation.mode === 'bot' &&
      conversation.messages.filter(
        (m) => m.role === 'customer' && Math.abs(sentAt - Date.parse(m.createdAt)) < 60000,
      ).length +
        1 >=
        messagesPerCustomerPerMinute
    )
      return await savePause(repo, company, conversation, input, {
        reason: 'burst',
        until: { afterMs: BURST_PAUSE_MS },
        text: burstNotice,
        notice: 'burst',
        trace: {
          action: 'staff_attention',
          code: 'burst',
          detail: `${messagesPerCustomerPerMinute} messages arrived from this customer within a minute. The bot answers them again after ${BURST_PAUSE_MS / 60000} minutes.`,
        },
      });
    // Cancelling an order needs no menu, so a Sheet that cannot be read never holds it up.
    const cancelling =
      input.action?.type === 'cancel' || cancelsSubmittedOrder(conversation, input.text);
    // A sheet-backed catalog is refreshed before any potentially mutating bot turn. While the
    // Sheet cannot be read, the menu last read from it is used for up to 12 hours.
    if (
      company.catalogSource === 'sheets' &&
      conversation.mode === 'bot' &&
      company.botEnabled &&
      !cancelling &&
      (!company.catalogSyncedAt || Date.now() - Date.parse(company.catalogSyncedAt) > 60000)
    ) {
      const refresh = await refreshSheetMenu(repo, company);
      if (!refresh.ok && sandbox && refresh.error)
        throw new PublicError(
          `Could not refresh the connected menu Sheet: ${sanitizeError(refresh.error)}`,
          503,
        );
      if (!refresh.ok && !refresh.usable && !sandbox)
        return await saveHandoff(
          repo,
          company,
          conversation,
          input,
          pick(
            noticeLanguage(company, conversation, input.text),
            'We can’t load our menu right now. A staff member will reply here to help with your order.',
            'ابھی ہمارا مینو لوڈ نہیں ہو رہا۔ عملے کا ایک رکن یہیں آپ کے آرڈر میں مدد کرے گا۔',
            'Abhi hamara menu load nahi ho raha. Staff ka koi member yahin aap ke order mein madad karega.',
          ),
          'menu_sync',
          refresh.error,
        );
    }
    const products = await repo.listProducts(company.id);
    if (codeUsable && company.botEnabled && conversation.mode === 'bot')
      return await redeemMenuDraft(repo, company, products, conversation, input, menuCode!);
    // The order this chat placed: its real status answers "where is my order?", and once it is
    // finished (or the cart was cancelled) the next message starts a fresh cart, as "new order"
    // would. An order still with the restaurant keeps its cart. A cancel or a status question
    // is about the old order, so it keeps the cart too.
    const cart = conversation.cart;
    const placed =
      cart.orderId && (cart.status === 'submitted' || cart.status === 'cancelled')
        ? await repo
            .getOrder(company.id, cart.orderId)
            .then((order) => (order?.conversationId === conversation.id ? order : undefined))
        : undefined;
    const finished =
      cart.status === 'cancelled' ||
      (cart.status === 'submitted' &&
        (!placed || ['completed', 'rejected', 'cancelled'].includes(placed.status)));
    if (
      finished &&
      conversation.mode === 'bot' &&
      company.botEnabled &&
      !cancelling &&
      !(asksOrderStatus(input.text) && !input.action)
    ) {
      conversation = structuredClone(conversation);
      // A new revision, so the next order can never reuse an earlier submission key.
      conversation.cart = { ...emptyCart(), revision: cart.revision + 1 };
      delete conversation.pendingItemChoice;
    }
    const latestOrder =
      placed && conversation.cart.orderId === placed.id
        ? {
            reference: placed.reference,
            status: placed.status,
            fulfillment: placed.fulfillment,
            createdAt: placed.createdAt,
            updatedAt: placed.updatedAt,
          }
        : undefined;
    // The public menu page, when it is on: menu replies share it and fill {menu_link}.
    const menuUrl = await menuPublicUrl(repo, company.id).catch(() => undefined);
    let actions: BotAction[] | undefined;
    let modelResponse: import('../src/shared/types.js').ModelResponse | undefined;
    let interpretation: ModelInterpretation | undefined;
    let ruleOverride: 'handoff' | 'reply' | undefined;
    const submittedCancellation = cancelsSubmittedOrder(conversation, input.text);
    // "staff" (as the automated-assistant notice offers) reaches a person without any AI.
    if (!input.action && isStaffRequest(input.text)) actions = [{ type: 'handoff' }];
    // "Where is my order?" about the order loaded above: the engine states its real status and
    // drops any AI text, so no AI is paid for.
    const statusQuestion = !input.action && !!latestOrder && asksOrderStatus(input.text);
    const skipped: ModelSkipReason | undefined = stale
      ? 'late'
      : input.action
        ? 'button'
        : submittedCancellation
          ? 'cancellation'
          : company.ai.provider === 'mock'
            ? 'local_rules'
            : conversation.mode !== 'bot'
              ? 'staff_mode'
              : !company.botEnabled
                ? 'paused'
                : undefined;
    if (sandbox && !input.action && company.ai.provider === 'mock' && !submittedCancellation)
      throw new PublicError(
        'Connect an AI model in Bot settings → AI model before testing customer messages.',
        409,
      );
    if (sandbox && !input.action && company.ai.provider !== 'mock' && !submittedCancellation) {
      const key = await providerKey(repo, company);
      if (company.modelVerification?.fingerprint !== modelFingerprint(company, key))
        throw new PublicError(
          'Click Connect and test in Bot settings → AI model before testing conversations.',
          409,
        );
    }
    // Pending choices are conversation context, not a reason to bypass the
    // configured model/rules. Validate proposed cart edits in the domain engine.
    if (
      !input.action &&
      !actions &&
      !submittedCancellation &&
      !statusQuestion &&
      company.ai.provider !== 'mock' &&
      conversation.mode === 'bot' &&
      company.botEnabled
    ) {
      try {
        interpretation = await new AiModelAdapter(repo).interpret(
          company,
          products,
          conversation,
          input.text,
        );
        const proposal = interpretation;
        const matchedRule = botConfig(company).behaviorRules.find(
          (rule) => rule.enabled && rule.id === proposal.response?.matchedRuleId,
        );
        if (matchedRule?.action === 'handoff' || matchedRule?.action === 'reply')
          ruleOverride = matchedRule.action;
        actions =
          matchedRule?.action === 'handoff'
            ? [{ type: 'handoff' }]
            : matchedRule?.action === 'reply'
              ? [{ type: 'answer', text: proposal.response?.text ?? matchedRule.response }]
              : proposal.actions;
        modelResponse = proposal.response;
      } catch (error) {
        if (sandbox)
          throw error instanceof PublicError ? error : new PublicError(sanitizeError(error), 503);
        // Nothing was spent yet: the message is processed again, unless this is its last try.
        if (error instanceof StoreUnavailableError && options.retryable) throw error;
        // The AI could not answer. Staff see the chat, and the bot tries again on the
        // customer's next message after a few minutes, unless staff wrote.
        if (!(error instanceof AiLimitError))
          return await savePause(repo, company, conversation, input, {
            reason: 'ai_error',
            until: { afterMs: AI_ERROR_PAUSE_MS },
            text: aiErrorNotice,
            notice: 'ai_error',
            trace: {
              action: 'staff_attention',
              code:
                error instanceof AiCallError
                  ? `ai_${error.reason}`
                  : error instanceof StoreUnavailableError
                    ? 'store_unavailable'
                    : 'ai_unavailable',
              detail: `${sanitizeError(error)} The bot tries again after ${AI_ERROR_PAUSE_MS / 60000} minutes.`,
            },
          });
        if (!asksForPerson(input.text))
          return await saveLimitPause(repo, company, conversation, input, error);
        // Asking for a person needs no AI: the engine hands the chat to staff for good, and
        // the bot does not take it back when the limit resets.
        actions = [{ type: 'handoff' }];
      }
    }
    // A settings change during a slow model call takes effect before this turn acts.
    company = selectConfig((await repo.getCompany(company.id)) ?? company);
    // For a submitted order, cancel only while it is still awaiting staff acceptance.
    if (
      conversation.mode === 'bot' &&
      company.botEnabled &&
      conversation.cart.orderId &&
      (input.action?.type === 'cancel' || asksToCancelOrder(input.text))
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
        const lang = noticeLanguage(company, conversation, input.text);
        const reply = disclosed(
          company,
          conversation,
          pick(
            lang,
            `Order ${order.reference} has been cancelled.`,
            `آرڈر ${order.reference} منسوخ کر دیا گیا ہے۔`,
            `Order ${order.reference} cancel kar diya gaya hai.`,
          ),
          lang,
          input.now,
        );
        const explanation = describeTurn({
          company,
          conversation,
          input,
          steps: ['order_cancelled'],
          decision: { parts: ['engine'], modelText: 'none', corrections: [] },
          outcome: 'reply',
          orderReference: order.reference,
          interpretation,
          skipped,
        });
        c.messages.push(
          {
            id: input.messageId,
            role: 'customer',
            text: input.text || 'Cancel order',
            createdAt: input.now,
          },
          { id: randomUUID(), role: 'assistant', text: reply, createdAt: input.now, explanation },
        );
        const cancelled = await changeOrderStatus(repo, order, 'cancelled', input.now, c, reply);
        return {
          conversation: c,
          order: cancelled,
          reply,
          traces: ['order_cancelled'],
          explanation,
        };
      }
    }
    const result = processTurn(
      company,
      products,
      conversation,
      { ...input, menuLink: menuUrl, appHost: appHost(), ...(latestOrder && { latestOrder }) },
      actions,
      modelResponse,
    );
    const replyId = `${input.messageId}:reply`;
    // A refused pickup or delivery choice in the customer's language, on the stored reply too.
    if (result.reply && result.traces.some((trace) => trace.startsWith('validation_failed:'))) {
      const localized = localizedRefusals(result.reply, result.conversation.language);
      const stored = result.conversation.messages.find(
        (m) => m.id === replyId && m.role === 'assistant',
      );
      if (localized !== result.reply && stored?.text === result.reply) {
        stored.text = localized;
        result.reply = localized;
      }
    }
    // The automated-assistant notice, on the stored reply too (the next turn reads it). A review
    // that would grow past WhatsApp's 1,024 characters for buttons gets it on the next reply.
    const withNotice = result.reply
      ? disclosed(company, conversation, result.reply, result.conversation.language, input.now)
      : result.reply;
    const reviewButtons =
      result.conversation.cart.status === 'awaiting_confirmation' &&
      result.conversation.cart.reviewMessageId === replyId &&
      result.reply.length <= 1024;
    if (withNotice !== result.reply && !(reviewButtons && withNotice.length > 1024)) {
      const stored = result.conversation.messages.find(
        (m) => m.id === replyId && m.role === 'assistant',
      );
      if (stored) {
        stored.text = withNotice;
        result.reply = withNotice;
      }
    }
    // The AI answered, so an older limit pause kept after a button tap has run its course.
    if (interpretation) delete result.conversation.limitPause;
    if (result.reply && result.decision) {
      result.explanation = describeTurn({
        company,
        conversation,
        input,
        steps: result.traces,
        decision: result.decision,
        outcome: result.order ? 'order' : result.conversation.mode === 'human' ? 'staff' : 'reply',
        orderReference: result.order?.reference,
        interpretation,
        skipped,
        ruleOverride,
      });
      attachExplanation(result.conversation, `${input.messageId}:reply`, result.explanation);
    }
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
          ...jobAddress(conversation),
          conversationId: conversation.id,
          messageId: result.conversation.messages.at(-1)?.id,
          text: result.reply,
          cartRevision: result.conversation.cart.revision,
          // An order confirmation always goes, even if the bot is switched off or staff take
          // over before it is delivered: the order exists, so the customer must hear of it.
          source: result.order || result.conversation.mode === 'human' ? 'notice' : 'bot',
          // Personalised for this customer only when sent; the stored text keeps the public link.
          ...(menuUrl && result.reply.includes(menuUrl) && { menuLink: true }),
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
  cause: StaffNoticeCause,
  reason?: unknown,
): Promise<TurnResult> {
  const c = structuredClone(conversation);
  c.mode = 'human';
  delete c.botPausedAt;
  delete c.limitPause;
  c.version++;
  c.updatedAt = input.now;
  c.lastInboundAt = new Date(
    Math.max(Date.parse(c.lastInboundAt), Date.parse(input.now)),
  ).toISOString();
  const explanation = describeTurn({
    company,
    conversation,
    input,
    steps: ['staff_attention'],
    decision: { parts: ['notice'], modelText: 'none', corrections: [] },
    outcome: 'staff',
    notice: cause,
  });
  reply = disclosed(
    company,
    conversation,
    reply,
    noticeLanguage(company, conversation, input.text),
    input.now,
  );
  c.messages.push(
    { id: input.messageId, role: 'customer', text: input.text, createdAt: input.now },
    { id: randomUUID(), role: 'assistant', text: reply, createdAt: input.now, explanation },
  );
  const jobs =
    c.channel === 'whatsapp'
      ? [
          makeJob(company.id, 'whatsapp_send', {
            ...jobAddress(c),
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
    code: cause,
    model: company.ai.model,
    botVersion: company.bot?.published?.version,
    createdAt: input.now,
  });
  for (const job of jobs) await dispatchJob(repo, job);
  return { conversation: c, reply, traces: ['staff_attention'], explanation };
}
const LIMIT_NOTICE: Record<AiLimitError['limit'], StaffNoticeCause> = {
  monthly: 'ai_budget',
  hourly: 'hourly_limit',
  customer: 'customer_limit',
};
// An AI limit stopped the bot. The chat waits for staff and goes back to the bot when the limit
// resets (see resumesAfterLimit).
async function saveLimitPause(
  repo: Repository,
  company: Company,
  conversation: Conversation,
  input: TurnInput,
  limit: AiLimitError,
): Promise<TurnResult> {
  const now = new Date();
  // A pause interrupted by a button tap continues until its original time.
  const earlier = conversation.limitPause;
  const until =
    limit.limit === 'customer'
      ? earlier?.reason === 'customer' && Date.parse(earlier.until) > now.getTime()
        ? earlier.until
        : new Date(now.getTime() + CUSTOMER_LIMIT_PAUSE_MS).toISOString()
      : (limit.resetAt ??
        (limit.limit === 'monthly'
          ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString()
          : new Date(Math.floor(now.getTime() / 3600000) * 3600000 + 3600000).toISOString()));
  return savePause(
    repo,
    company,
    conversation,
    input,
    {
      reason: limit.limit,
      until,
      // Before the migration only the monthly check exists, without the value.
      limit: limit.limitValue ?? (limit.limit === 'monthly' ? company.ai.monthlyBudgetUsd : 0),
      text: limitNotice,
      notice: LIMIT_NOTICE[limit.limit],
      trace: {
        action: 'ai_limit_reached',
        detail: `${limit.message} The bot answers again after ${until}.`,
        code: `ai_limit_${limit.limit}`,
      },
    },
    now,
  );
}
type PauseReason = NonNullable<Conversation['limitPause']>['reason'];
interface Pause {
  reason: PauseReason;
  // When it ends: a time, or how long after it starts.
  until: string | { afterMs: number };
  // The limit's value when raising it ends the pause early. Left out for a pause that only
  // ends at `until`: no setting is ever above it, so resumesAfterLimit waits for the time.
  limit?: number;
  text: (lang: Language, cart: Cart) => string;
  notice?: StaffNoticeCause;
  skipped?: ModelSkipReason;
  trace: { action: string; detail: string; code: string };
}
// What a customer is told when they sent many messages at once, or a message reached Orderly
// hours late. Like the limit notice, it says a person will see it and whether the order is safe.
function burstNotice(lang: Language, cart: Cart): string {
  const minutes = BURST_PAUSE_MS / 60000;
  const base = pick(
    lang,
    `You’ve sent a lot of messages at once, so automatic replies are paused for ${minutes} minutes. Our team can still see your messages.`,
    `آپ نے ایک ساتھ بہت سے پیغامات بھیجے ہیں، اس لیے خودکار جوابات ${minutes} منٹ کے لیے روک دیے گئے ہیں۔ ہماری ٹیم آپ کے پیغامات دیکھ سکتی ہے۔`,
    `Aap ne ek saath bohat se messages bheje hain, is liye automatic jawab ${minutes} minute ke liye ruk gaye hain. Hamari team aap ke messages dekh sakti hai.`,
  );
  const order = orderSafetyLine(lang, cart);
  return order ? `${base} ${order}` : base;
}
function lateNotice(lang: Language, cart: Cart): string {
  const base = pick(
    lang,
    'Sorry, your message reached us late. Our team will reply here soon.',
    'معذرت، آپ کا پیغام ہمیں دیر سے ملا۔ ہماری ٹیم جلد یہیں جواب دے گی۔',
    'Maazrat, aap ka message hamein der se mila. Hamari team jald yahin jawab degi.',
  );
  const order = orderSafetyLine(lang, cart);
  return order ? `${base} ${order}` : base;
}
const pick = (lang: Language, en: string, ur: string, roman: string) =>
  lang === 'ur' ? ur : lang === 'roman-ur' ? roman : en;
/**
 * The engine words a refused pickup or delivery choice in English only (fulfillmentRefusal in
 * src/domain/engine.ts), behind the customer's own language. Those exact sentences are said in
 * the customer's language here, with the same words the engine uses when it asks for the
 * choice, and the English one loses its "fulfillment choice" jargon. Nothing else is changed.
 */
export function localizedRefusals(text: string, lang: Language): string {
  return text
    .replace(
      /This restaurant currently offers (pickup|delivery) only\.( Please update your fulfillment choice\.)?/g,
      (sentence, offered: 'pickup' | 'delivery', update?: string) =>
        pick(
          lang,
          update
            ? `This restaurant currently offers ${offered} only. Please choose ${offered}.`
            : sentence,
          offered === 'pickup'
            ? 'ابھی صرف پک اپ دستیاب ہے۔ براہ کرم پک اپ منتخب کریں۔'
            : 'ابھی صرف ڈیلیوری دستیاب ہے۔ براہ کرم ڈیلیوری منتخب کریں۔',
          `Abhi sirf ${offered} available hai. Meherbani karke ${offered} chunein.`,
        ),
    )
    .replace(
      'Ordering in this chat is not available right now. Please ask our staff for help.',
      pick(
        lang,
        'Ordering in this chat is not available right now. Please ask our staff for help.',
        'ابھی اس چیٹ میں آرڈر دستیاب نہیں ہے۔ براہ کرم عملے سے رابطہ کریں۔',
        'Abhi is chat mein order available nahi hai. Meherbani karke staff se baat karein.',
      ),
    )
    .replace(
      'We do not deliver right now.',
      pick(
        lang,
        'We do not deliver right now.',
        'ابھی ہم ڈیلیوری نہیں کر رہے۔',
        'Abhi hum delivery nahi kar rahe.',
      ),
    )
    .replace(/We deliver to: ([^\n]+)\./, (sentence, zones: string) =>
      pick(
        lang,
        sentence,
        `ہم ان علاقوں میں ڈیلیوری کرتے ہیں: ${zones}۔`,
        `Hum in ilaqon mein delivery karte hain: ${zones}.`,
      ),
    );
}
/**
 * The customer's notice for an order status change, in their language. English keeps the
 * standard "Order X is now …" line; Urdu and Roman Urdu use the engine's own status wording.
 */
export function statusNoticeText(
  company: Company,
  conversation: Conversation | undefined,
  order: Order,
  status: Order['status'],
  now = new Date().toISOString(),
): string {
  const lang = conversation ? noticeLanguage(company, conversation, '') : 'en';
  if (lang === 'en') return `Order ${order.reference} is now ${status.replaceAll('_', ' ')}.`;
  return orderStatusText(
    lang,
    {
      reference: order.reference,
      status,
      fulfillment: order.fulfillment,
      createdAt: order.createdAt,
      updatedAt: now,
    },
    now,
  ).split('\n')[0]!;
}
// The automated-assistant notice that starts every chat session, on WhatsApp chats only.
function disclosed(
  company: Company,
  before: Conversation,
  reply: string,
  lang: Language,
  now: string,
): string {
  return before.channel === 'whatsapp'
    ? withDisclosure(company.name, before, reply, lang, now)
    : reply;
}
// The bot stops answering this chat until `until` (or the limit is raised): staff see it under
// "Needs staff", and it goes back to the bot by itself unless staff wrote. Only this customer
// is paused. They are told once an hour at most, so a flood of messages gets one notice.
async function savePause(
  repo: Repository,
  company: Company,
  conversation: Conversation,
  input: TurnInput,
  pause: Pause,
  now = new Date(),
): Promise<TurnResult> {
  const at = now.toISOString();
  const notify =
    !conversation.limitNoticeAt ||
    now.getTime() - Date.parse(conversation.limitNoticeAt) >= LIMIT_NOTICE_INTERVAL_MS;
  const c = structuredClone(conversation);
  c.mode = 'human';
  delete c.botPausedAt;
  c.limitPause = {
    reason: pause.reason,
    at,
    until:
      typeof pause.until === 'string'
        ? pause.until
        : new Date(now.getTime() + pause.until.afterMs).toISOString(),
    limit: pause.limit ?? Number.MAX_SAFE_INTEGER,
  };
  c.language = noticeLanguage(company, conversation, input.text);
  c.version++;
  c.updatedAt = input.now;
  c.lastInboundAt = new Date(
    Math.max(Date.parse(c.lastInboundAt), Date.parse(input.now)),
  ).toISOString();
  c.messages.push({
    id: input.messageId,
    role: 'customer',
    text: input.text.slice(0, 4000),
    createdAt: input.now,
  });
  let reply = '';
  let explanation: TurnResult['explanation'];
  if (notify) {
    reply = disclosed(company, conversation, pause.text(c.language, c.cart), c.language, input.now);
    c.limitNoticeAt = at;
    explanation = describeTurn({
      company,
      conversation,
      input,
      steps: ['staff_attention'],
      decision: { parts: ['notice'], modelText: 'none', corrections: [] },
      outcome: 'staff',
      ...(pause.notice && { notice: pause.notice }),
      ...(pause.skipped && { skipped: pause.skipped }),
    });
    c.messages.push({
      id: randomUUID(),
      role: 'assistant',
      text: reply,
      createdAt: input.now,
      explanation,
    });
  }
  const jobs =
    notify && c.channel === 'whatsapp'
      ? [
          makeJob(company.id, 'whatsapp_send', {
            ...jobAddress(c),
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
    ...pause.trace,
    model: company.ai.model,
    botVersion: company.bot?.published?.version,
    createdAt: input.now,
  });
  for (const job of jobs) await dispatchJob(repo, job);
  return {
    conversation: c,
    reply,
    traces: [notify ? 'staff_attention' : 'human_mode_message_saved'],
    explanation,
  };
}
// "cancel" for an order already sent to the restaurant: the engine handles it without AI. The
// same recogniser as the engine's, so both agree on what counts as a cancel request.
const cancelsSubmittedOrder = (conversation: Conversation, text: string) =>
  Boolean(conversation.cart.orderId) && asksToCancelOrder(text);
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
/** `text`: the customer's notice in place of the standard "Order X is now …" line. */
export async function changeOrderStatus(
  repo: Repository,
  order: Order,
  status: Order['status'],
  now = new Date().toISOString(),
  automatedConversation?: Conversation,
  text?: string,
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
        ...jobAddress(conversation),
        conversationId: conversation.id,
        text: text ?? `Order ${order.reference} is now ${status.replaceAll('_', ' ')}.`,
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
// A customer's order is still waiting for the restaurant (the database queues this job 15
// minutes after it was placed, once per order). They are told once, in their language, while
// WhatsApp still lets the business write to them; otherwise nothing is sent. It claims nothing
// about staff (no one is reminded by it), and says how to cancel only where "cancel" would
// cancel exactly this order: the bot handles the chat and its current order is this one.
const FOLLOWUP_WINDOW_MS = 24 * 60 * 60 * 1000 - 5 * 60 * 1000;
async function sendOrderFollowup(repo: Repository, stored: Company, job: Job) {
  const company = configuredCompany(stored);
  const due = await repo.getOrder(company.id, String(job.payload.orderId));
  if (!due || due.conversationId !== String(job.payload.conversationId)) return;
  // Under the chat's lock like any turn, so it never lands in the middle of one (which would
  // make that turn start again and pay for its AI call twice). A busy chat is tried later.
  const lockId = randomUUID();
  if (
    !(await repo.acquireConversationLock(
      company.id,
      due.conversationId,
      lockId,
      new Date(Date.now() + workerLeaseMs()).toISOString(),
    ))
  )
    throw new PublicError('The conversation is busy. The reminder is tried again later.', 409);
  try {
    const order = await repo.getOrder(company.id, due.id);
    const conversation = await repo.getConversation(company.id, due.conversationId);
    const messageId = `order-followup:${due.id}`;
    if (
      !order ||
      order.status !== 'pending' ||
      order.sandbox ||
      // Staff already spoke to the customer about this order on the phone.
      order.phoneConfirmation?.outcome === 'confirmed' ||
      order.phoneConfirmation?.outcome === 'declined' ||
      automationPaused() ||
      conversation?.channel !== 'whatsapp' ||
      conversation.blocked ||
      Date.now() - Date.parse(conversation.lastInboundAt) >= FOLLOWUP_WINDOW_MS ||
      conversation.messages.some((m) => m.id === messageId)
    )
      return;
    const lang = noticeLanguage(company, conversation, '');
    const ref = order.reference;
    const cancels =
      conversation.mode === 'bot' &&
      company.botEnabled &&
      conversation.cart.orderId === order.id &&
      conversation.cart.status === 'submitted';
    const text = [
      pick(
        lang,
        `Your order ${ref} is still waiting for the restaurant to accept it. You’ll get a message here when they accept or decline it.`,
        `آپ کا آرڈر ${ref} ابھی ریسٹورنٹ کی منظوری کا منتظر ہے۔ ریسٹورنٹ کے منظور یا مسترد کرنے پر آپ کو یہیں پیغام مل جائے گا۔`,
        `Aap ka order ${ref} abhi restaurant ki manzoori ka intezar kar raha hai. Restaurant ke accept ya decline karne par aap ko yahin message mil jayega.`,
      ),
      ...(cancels
        ? [
            pick(
              lang,
              `Reply “cancel” to cancel order ${ref}.`,
              `آرڈر ${ref} منسوخ کرنا ہو تو “منسوخ” یا “cancel” لکھیں۔`,
              `Order ${ref} cancel karna ho to “cancel” likhein.`,
            ),
          ]
        : []),
    ].join(' ');
    const next: Conversation = {
      ...conversation,
      version: conversation.version + 1,
      updatedAt: new Date().toISOString(),
      messages: [
        ...conversation.messages,
        // Automatic, so a chat staff answered last does not look as if it waits for them again.
        {
          id: messageId,
          role: 'assistant',
          text,
          createdAt: new Date().toISOString(),
          notice: true,
        },
      ],
    };
    // The order and status let the send drop the reminder if staff act on the order first.
    const send = makeJob(company.id, 'whatsapp_send', {
      ...jobAddress(conversation),
      conversationId: conversation.id,
      messageId,
      text,
      orderId: order.id,
      status: 'pending',
      source: 'notice',
    });
    if (!(await repo.commitTurn(company.id, next, conversation.version, undefined, [send])))
      throw new PublicError('The conversation changed while processing. Retrying.', 409);
    await repo
      .addTrace({
        id: randomUUID(),
        companyId: company.id,
        conversationId: conversation.id,
        action: 'order_followup',
        detail: `Told the customer that order ${ref} is still waiting for the restaurant.`,
        createdAt: new Date().toISOString(),
      })
      .catch(() => undefined);
    await dispatchJob(repo, send);
  } finally {
    await repo.releaseConversationLock(company.id, due.conversationId, lockId);
  }
}
export async function queueReply(
  repo: Repository,
  conversation: Conversation,
  text: string,
  order?: Order,
) {
  if (conversation.channel !== 'whatsapp') return;
  const job = makeJob(conversation.companyId, 'whatsapp_send', {
    ...jobAddress(conversation),
    conversationId: conversation.id,
    text,
    ...(order ? { orderId: order.id, reference: order.reference, status: order.status } : {}),
  });
  await repo.insertJob(job);
  await dispatchJob(repo, job);
}
// Sends share one lock with pairing and disconnecting, but each send holds it for only
// a second or two. Waiting here is far faster than a retry, which runs only on the next
// minute's recovery pass and let later replies overtake earlier ones.
const CONNECTION_LOCK_WAIT_MS = 30000;
// A send finishes well within this (the gateway call times out after 20 s), so a worker
// killed mid-send blocks the business's other sends for 90 s at most, never the full worker
// lease: half of it when the lease is short (Supabase Free).
const sendLockLeaseMs = () => Math.min(90000, Math.floor(workerLeaseMs() / 2));
async function acquireConnectionLock(
  repo: Repository,
  companyId: string,
  owner: string,
  {
    ready = async () => true,
    leaseMs = workerLeaseMs(),
    waitMs = CONNECTION_LOCK_WAIT_MS,
  }: { ready?: () => Promise<boolean>; leaseMs?: number; waitMs?: number } = {},
) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (
      (await ready()) &&
      (await repo.acquireConversationLock(
        companyId,
        'whatsapp-connection',
        owner,
        new Date(Date.now() + leaseMs).toISOString(),
      ))
    )
      return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}
// The Inbox shows a reply that never left as "Not delivered" with the reason. Keyed by
// the job: a real WhatsApp receipt for the same message outranks it.
async function recordNotSent(repo: Repository, job: Job, reason: string) {
  if (typeof job.payload.messageId !== 'string' || typeof job.payload.externalId === 'string')
    return;
  await repo.recordDelivery(
    job.companyId,
    `job:${job.id}`,
    'failed',
    String(job.payload.conversationId),
    job.payload.messageId,
    reason,
  );
}
// Why a queued automatic message must not go out any more, if it must not. A reply written
// before an AI limit paused the chat still goes: only staff taking over, the bot being
// switched off or a block stop it. A block also stops automatic notices; staff replies go.
export function droppedReplyReason(
  job: Job,
  conversation: Conversation,
  company: Company,
): string | undefined {
  const automatic = job.payload.source === 'bot' || job.payload.source === 'notice';
  if (automatic && conversation.blocked) return 'Not sent: this number was blocked.';
  if (job.payload.source !== 'bot') return undefined;
  if (!company.botEnabled || automationPaused() || conversation.botPausedAt)
    return 'Not sent: the bot was switched off before the reply went out.';
  const writtenBeforePause =
    !!conversation.limitPause && job.createdAt <= conversation.limitPause.at;
  if (conversation.mode === 'human' && !writtenBeforePause)
    return 'Not sent: staff took over this chat before the reply went out.';
  return undefined;
}
const PREVIOUS_CONNECTION = 'Not sent: queued for a previous WhatsApp connection.';
// The address a job or chat uses, when it is still the business's current WhatsApp connection.
async function currentAddress(
  repo: Repository,
  companyId: string,
  value: unknown,
): Promise<{ current: true; address?: WhatsAppAddress } | { current: false }> {
  try {
    return { current: true, address: await assertCurrentAddress(repo, companyId, value) };
  } catch (error) {
    if (error instanceof PublicError && error.status === 422) return { current: false };
    throw error;
  }
}
// A reply that can never go out (queued before the WhatsApp connection changed) ends as done,
// with the reason on the message, instead of failing again on every retry.
async function finishNotSent(repo: Repository, job: Job, reason: string) {
  await recordNotSent(repo, job, reason).catch(() => undefined);
  await repo
    .addTrace({
      id: randomUUID(),
      companyId: job.companyId,
      ...(typeof job.payload.conversationId === 'string' && {
        conversationId: job.payload.conversationId,
      }),
      action: 'whatsapp.not_sent',
      detail: reason,
      createdAt: new Date().toISOString(),
    })
    .catch(() => undefined);
  await repo.saveJob({ ...job, status: 'done', leaseUntil: undefined, error: undefined });
}
// One line per failed job for the function logs: what failed, never payloads, numbers or text.
function logJobFailure(job: Job, permanent: boolean, error: unknown) {
  const name = error instanceof Error ? error.name : typeof error;
  const code = (error as { code?: unknown } | undefined)?.code;
  const status = error instanceof PublicError ? error.status : undefined;
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk-[\w-]{8,}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, '[redacted]')
    .replace(/\+?\d[\d\s-]{6,}\d/g, '[number]');
  console.error(
    JSON.stringify({
      event: 'job_failed',
      jobId: job.id,
      kind: job.kind,
      companyId: job.companyId,
      attempts: job.attempts,
      permanent,
      error:
        `${[name, typeof code === 'string' ? code : undefined, status].filter(Boolean).join('/')}: ${message}`.slice(
          0,
          300,
        ),
    }),
  );
}
export async function processJob(repo: Repository, id: string) {
  const lease = workerLeaseMs();
  const job = await repo.claimJob(
    id,
    new Date().toISOString(),
    new Date(Date.now() + lease).toISOString(),
  );
  if (!job) return;
  let connectionLocked = false;
  // The connection is free for the business's next send as soon as WhatsApp has this one.
  const releaseConnection = async () => {
    if (!connectionLocked) return;
    connectionLocked = false;
    await repo.releaseConversationLock(job.companyId, 'whatsapp-connection', job.id);
  };
  try {
    // Only sending talks to WhatsApp. A customer's messages are already processed in
    // order per customer and under the conversation lock, so they must not hold the
    // connection while the AI answers: that blocked every reply and other customers.
    if (job.kind === 'whatsapp_send') {
      // Replies to one customer leave in the order they were written. An earlier send
      // still 'processing' counts only if claimed recently: a worker killed mid-send must
      // not hold back the customer's later replies until its worker lease runs out.
      const conversationId = String(job.payload.conversationId);
      const sendLease = sendLockLeaseMs();
      let waitingForEarlier = false;
      connectionLocked = await acquireConnectionLock(repo, job.companyId, job.id, {
        leaseMs: sendLease,
        ready: async () => {
          waitingForEarlier = await repo.hasEarlierSend(
            job.companyId,
            conversationId,
            job,
            new Date(Date.now() + lease - sendLease).toISOString(),
          );
          return !waitingForEarlier;
        },
      });
      if (!connectionLocked && waitingForEarlier) {
        // Waiting for an earlier reply is not this reply failing: keep its retries.
        await repo.saveJob({
          ...job,
          status: 'pending',
          attempts: job.attempts - 1,
          leaseUntil: undefined,
          nextRunAt: new Date(Date.now() + 10000).toISOString(),
          error: 'Waiting for an earlier reply to this customer to be sent.',
        });
        return;
      }
      if (!connectionLocked) throw new PublicError('WhatsApp connection is busy.', 409);
      if (!(await currentAddress(repo, job.companyId, job.payload.whatsappAddress)).current)
        return await finishNotSent(repo, job, PREVIOUS_CONNECTION);
    }
    if (job.kind === 'incoming')
      await assertCurrentAddress(repo, job.companyId, job.payload.whatsappAddress);
    if (job.attempts > 5)
      throw new PublicError('Repeated worker interruptions require staff review.', 503);
    const company = await repo.getCompany(job.companyId);
    if (!company) throw new PublicError('Job company no longer exists.', 404);
    if (job.kind === 'incoming') {
      const phone = String(job.payload.phone);
      const address = await assertCurrentAddress(repo, company.id, job.payload.whatsappAddress);
      // Blocked senders are dropped on arrival; this catches a message queued just before the
      // block. Staff messages from the business phone are never blocked.
      if (
        !job.payload.echo &&
        (await repo.findBlockedCustomer(company.id, customerKeys({ phone, peer: address?.peer })))
      ) {
        await repo.saveJob({ ...job, status: 'done', leaseUntil: undefined, error: undefined });
        return;
      }
      const existing = address
        ? await repo.findWhatsAppConversation(company.id, address)
        : await repo.findConversation(company.id, phone, 'whatsapp');
      // A privacy-protected chat can start before WhatsApp shares the customer's number.
      // Record it once known, so staff can see who they are talking to. Best effort.
      if (existing && !existing.customerPhone && phone)
        await repo.saveConversation(
          { ...existing, customerPhone: phone, version: existing.version + 1 },
          existing.version,
        );
      const conversation = existing ?? {
        ...createConversation(
          company.id,
          address ? `${address.connectionId}:${address.generation}:${address.peer}` : phone,
          'whatsapp',
          '1970-01-01T00:00:00.000Z',
        ),
        customerPhone: phone,
        ...(address ? { whatsappAddress: address } : {}),
        updatedAt: job.createdAt,
        lastInboundAt: job.createdAt,
      };
      if (job.payload.echo) {
        if (
          !(await repo.acquireConversationLock(
            company.id,
            conversation.id,
            job.id,
            new Date(Date.now() + lease).toISOString(),
          ))
        )
          throw new PublicError('Conversation is busy.', 409);
        try {
          const current = (await repo.getConversation(company.id, conversation.id)) ?? {
            ...conversation,
            lastInboundAt: '1970-01-01T00:00:00.000Z',
          };
          if (!current.messages.some((m) => m.id === job.payload.messageId)) {
            // A staff message replayed after a reconnect may predate staff handing the
            // chat back to the bot: record it, but leave the chat with the bot.
            const handedBackLater = !!current.botResumedAt && job.createdAt < current.botResumedAt;
            const next: Conversation = {
              ...current,
              ...(!handedBackLater && {
                mode: 'human' as const,
                botPausedAt: undefined,
                limitPause: undefined,
              }),
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
      } else {
        // A late message is still answered: the engine asks again before placing an order,
        // and a message hours late is left for staff (see handleTurn).
        const late = Date.now() - Date.parse(job.createdAt) > LATE_AFTER_MS;
        await handleTurn(
          repo,
          company,
          conversation,
          {
            messageId: String(job.payload.messageId),
            text: String(job.payload.text),
            action: job.payload.action as BotAction | undefined,
            now: job.createdAt,
            ...(late && { late }),
          },
          // The last tries hand a database outage to staff instead of failing for good.
          { retryable: job.attempts < 4 },
        );
      }
    } else if (job.kind === 'staff_alert') {
      await sendStaffAlert(repo, job);
    } else if (job.kind === 'order_followup') {
      // Never a WhatsApp send of its own: it decides whether to queue one.
      await sendOrderFollowup(repo, company, job);
    } else if (job.kind === 'sheet_sync') {
      const sheetLock = `sheet:${company.id}`;
      if (
        !(await repo.acquireConversationLock(
          company.id,
          sheetLock,
          job.id,
          new Date(Date.now() + lease).toISOString(),
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
    } else if (job.kind === 'whatsapp_send') {
      const conversation = await repo.getConversation(
        company.id,
        String(job.payload.conversationId),
      );
      if (!conversation) throw new PublicError('Conversation not found.', 404);
      const dropped = droppedReplyReason(job, conversation, company);
      if (dropped) {
        // Best effort: a failed note must not turn a dropped reply into a retrying job.
        await recordNotSent(repo, job, dropped).catch(() => undefined);
        await repo.saveJob({ ...job, status: 'done', leaseUntil: undefined, error: undefined });
        return;
      }
      if (conversation.channel !== 'whatsapp')
        throw new PublicError('Sandbox cannot send WhatsApp messages.', 422);
      const target = await currentAddress(repo, company.id, conversation.whatsappAddress);
      if (!target.current) return await finishNotSent(repo, job, PREVIOUS_CONNECTION);
      const address = target.address;
      if (address && !sameAddress(address, job.payload.whatsappAddress as typeof address))
        throw new PublicError('Queued message destination changed. Staff review required.', 422);
      const adapter =
        address?.provider === 'baileys'
          ? new LinkedWhatsAppAdapter(repo, company.id, job.id)
          : await integrationAdapter(repo, company.id, 'whatsapp');
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
        // Never attach a new cart's confirmation to an older queued response: the Confirm
        // button goes only with the message that showed the review the cart awaits.
        if (
          job.payload.cartRevision !== conversation.cart.revision ||
          job.payload.messageId !== conversation.cart.reviewMessageId
        )
          snapshot.cart.status = 'building';
        // The menu page link becomes this customer's own one-tap link, only in what is sent.
        const text =
          job.payload.menuLink === true
            ? await personalMenuText(repo, company, conversation, job, String(job.payload.text))
            : String(job.payload.text);
        messageId = await adapter.send(snapshot, text);
      }
      // Checkpoint the provider receipt before bookkeeping. Retrying this job
      // reuses the receipt instead of sending the same message again.
      job.payload.externalId = messageId;
      await repo.saveJob(job);
      // WhatsApp has the message: the business's next send need not wait for the bookkeeping.
      await releaseConnection();
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
        detail: `Message accepted by WhatsApp transport: ${messageId}`,
        createdAt: new Date().toISOString(),
      });
    } else throw new PublicError('This version of Orderly cannot run this kind of job.', 422);
    await repo.saveJob({ ...job, status: 'done', leaseUntil: undefined, error: undefined });
  } catch (error) {
    const permanent = job.attempts >= 5 || (error instanceof PublicError && error.status === 422);
    logJobFailure(job, permanent, error);
    // A customer's message that can never be processed is put in the chat for staff instead,
    // so it no longer holds back the customer's later messages.
    const recorded =
      permanent && job.kind === 'incoming'
        ? await recordFailedMessage(
            repo,
            job,
            // A message for a previous connection never starts a chat of its own.
            !(error instanceof PublicError && error.status === 422),
          ).catch(() => undefined)
        : undefined;
    const released = !!recorded?.released;
    await repo.saveJob({
      ...job,
      status: released ? 'done' : permanent ? 'failed' : 'pending',
      ...(released && { payload: { ...job.payload, failedPermanently: true } }),
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
    if (permanent && job.kind === 'whatsapp_send')
      await recordNotSent(
        repo,
        job,
        error instanceof PublicError
          ? error.message
          : 'Sending failed. Check the WhatsApp connection.',
      ).catch(() => undefined);
    // An incoming message that could not be recorded remains a FIFO barrier until recovery.
    // Mark its conversation for staff too, so retrying the stream cannot resume ordering
    // silently.
    let failedConversationId = recorded?.conversationId;
    if (permanent && job.kind === 'incoming' && !released) {
      const address = job.payload.whatsappAddress as WhatsAppAddress | undefined;
      const current = address
        ? await repo.findWhatsAppConversation(job.companyId, address)
        : await repo.findConversation(job.companyId, String(job.payload.phone), 'whatsapp');
      if (current) {
        failedConversationId = current.id;
        // A blocked number's chat stays as it is: no message of theirs will be processed.
        if (
          !current.blocked &&
          (current.mode === 'bot' || current.botPausedAt || current.limitPause)
        )
          await repo.saveConversation(
            {
              ...current,
              mode: 'human',
              botPausedAt: undefined,
              limitPause: undefined,
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
  } finally {
    await releaseConnection();
  }
}
/**
 * A message that failed for good goes into its chat as it arrived, and the chat goes to staff,
 * as for any message the bot cannot answer. Its job can then end, so the customer's later
 * messages are recorded too. A blocked number's chat is left alone. `released` is false when
 * the chat could not be saved: the job then stays failed and holds those messages back.
 */
async function recordFailedMessage(
  repo: Repository,
  job: Job,
  create: boolean,
): Promise<{ conversationId?: string; released: boolean }> {
  const address = job.payload.whatsappAddress as WhatsAppAddress | undefined;
  const phone = String(job.payload.phone ?? '');
  const messageId = String(job.payload.messageId);
  for (let attempt = 0; attempt < 2; attempt++) {
    const found = address
      ? await repo.findWhatsAppConversation(job.companyId, address)
      : await repo.findConversation(job.companyId, phone, 'whatsapp');
    if (found?.blocked) return { conversationId: found.id, released: true };
    if (!found && !create) return { released: false };
    const current: Conversation = found ?? {
      ...createConversation(
        job.companyId,
        address ? `${address.connectionId}:${address.generation}:${address.peer}` : phone,
        'whatsapp',
        '1970-01-01T00:00:00.000Z',
      ),
      customerPhone: phone,
      ...(address ? { whatsappAddress: address } : {}),
      updatedAt: job.createdAt,
      lastInboundAt: job.createdAt,
    };
    const fromCustomer = !job.payload.echo;
    const next: Conversation = {
      ...current,
      mode: 'human',
      botPausedAt: undefined,
      limitPause: undefined,
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
      ...(fromCustomer && {
        lastInboundAt: new Date(
          Math.max(Date.parse(current.lastInboundAt), Date.parse(job.createdAt)),
        ).toISOString(),
      }),
      messages: current.messages.some((m) => m.id === messageId)
        ? current.messages
        : [
            ...current.messages,
            {
              id: messageId,
              role: fromCustomer ? 'customer' : 'staff',
              text: String(job.payload.text ?? '').slice(0, 4000),
              createdAt: job.createdAt,
            },
          ],
    };
    if (await repo.saveConversation(next, current.version))
      return { conversationId: current.id, released: true };
  }
  return { released: false };
}
