import type { Company, Role } from '../src/shared/types.js';
import type {
  AgentFlow,
  FlowFact,
  FlowNode,
  PlatformCheck,
  RecentReply,
  SetupStep,
} from '../src/shared/agent-flow.js';
import { botConfig, cashOnly, paymentMethods, sameBotConfig } from '../src/shared/bot.js';
import {
  AI_ERROR_PAUSE_MS,
  BURST_PAUSE_MS,
  effectiveAiLimits,
  generationProfile,
  MODEL_LIMITS,
  PROVIDER_NAMES,
} from '../src/shared/models.js';
import { isOpen } from '../src/domain/engine.js';
import type { Repository } from './repository.js';
import { appMode, env } from './config.js';
import { readiness } from './readiness.js';
import { modelRate, promptCacheEnabled, providerKey } from './integrations/models.js';
import { modelFingerprint } from './integrations/model-catalog.js';
import { gatewayAvailable } from './whatsapp/client.js';
import { GATEWAY_HEARTBEAT_STALE_MS } from '../src/shared/whatsapp.js';

const TRANSFER_LABELS = {
  jazzcash: 'JazzCash',
  easypaisa: 'Easypaisa',
  bank_transfer: 'bank transfer',
};
// The payment methods customers are told about, as the order confirmation words them.
function paymentOptions(company: Company): string {
  if (cashOnly(company)) return 'Payment options are cash on pickup or delivery.';
  const methods = paymentMethods(company);
  const transfers = methods.flatMap((method) => (method === 'cash' ? [] : TRANSFER_LABELS[method]));
  return `Payment options are ${methods.includes('cash') ? 'cash on pickup or delivery, or ' : ''}${transfers.join(' / ')}. For a transfer the restaurant shares its payment details and confirms the transfer itself; Orderly never sends account numbers.`;
}
const usd = (value: number) => `$${value.toFixed(value > 0 && value < 0.01 ? 4 : 2)}`;
const yes = (value: boolean, ok = 'Yes', no = 'No') => (value ? ok : no);
const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** Builds the live map of everything connected to this business's bot. */
export async function buildAgentFlow(
  repo: Repository,
  company: Company,
  role: Role,
): Promise<AgentFlow> {
  const mode = appMode();
  const [products, integrations, connection, checks, summary, testOrders, live, sandbox] =
    await Promise.all([
      repo.listProducts(company.id),
      repo.getIntegrations(company.id),
      repo.getWhatsAppConnection(company.id),
      readiness(repo, company),
      repo.getSummary(company.id, mode === 'demo'),
      repo.queryOrders(company.id, { pageSize: 25, sandbox: true }),
      repo.queryConversations(company.id, { pageSize: 15, sandbox: false }),
      repo.queryConversations(company.id, { pageSize: 15, sandbox: true }),
    ]);
  // Demo sample orders are fixtures, not orders the operator placed while testing.
  const testOrderCount = testOrders.items.filter(
    (order) => !order.submissionKey?.startsWith('fixture:'),
  ).length;
  const ready = (id: string) => checks.find((check) => check.id === id)?.ready ?? false;
  const published = botConfig(company);
  const ai = company.ai;
  const limits = effectiveAiLimits(company.aiLimits);
  const usesAi = ai.provider !== 'mock';
  let keyAvailable = !usesAi;
  let verified = false;
  if (usesAi) {
    try {
      const key = await providerKey(repo, company);
      keyAvailable = true;
      verified = company.modelVerification?.fingerprint === modelFingerprint(company, key);
    } catch {
      // Only availability is reported; credentials and decryption errors never are.
    }
  }
  let rates: [number, number] | undefined;
  try {
    if (usesAi) rates = modelRate(ai.model, ai.pricing);
  } catch {
    rates = undefined;
  }
  const approved = !!company.privacy?.aiDataApproved;
  const profile = generationProfile(ai.provider, ai.model);
  const available = products.filter((product) => product.available);
  const sheets = integrations.find((integration) => integration.kind === 'sheets');
  const meta = integrations.find((integration) => integration.kind === 'whatsapp');
  const linked = connection?.provider === 'baileys';
  const whatsappReady = ready('whatsapp');
  const knowledgeCount = (company.faqs?.length ?? 0) + published.knowledge.length;
  const hours = company.openingHours ?? { start: '00:00', end: '00:00', days: [] };
  const zones = company.deliveryZones ?? [];
  const enabledRules = published.behaviorRules.filter((rule) => rule.enabled);
  const draftChanged =
    !!company.bot?.published && !sameBotConfig(company.bot.draft, company.bot.published.config);
  const heartbeatAge = connection?.lastHeartbeatAt
    ? Math.max(0, Math.round((Date.now() - Date.parse(connection.lastHeartbeatAt)) / 1000))
    : undefined;
  const channelName = linked
    ? 'WhatsApp (linked phone)'
    : meta?.configured
      ? 'WhatsApp Business (Meta)'
      : 'WhatsApp';

  const channel: FlowNode = {
    id: 'channel',
    title: channelName,
    subtitle: whatsappReady
      ? connection?.phoneNumber || 'Connected'
      : linked
        ? `Linked phone · ${connection?.status.replaceAll('_', ' ')}`
        : meta?.configured
          ? 'Saved, not verified yet'
          : 'Not connected',
    status: whatsappReady ? 'ready' : linked || meta?.configured ? 'attention' : 'off',
    statusLabel: whatsappReady
      ? 'Connected'
      : linked || meta?.configured
        ? 'Needs attention'
        : 'Not connected',
    editable: true,
    page: 'integrations',
    pageLabel: 'Integrations',
    what: 'Where real customer messages come in. Each message is checked, de-duplicated and queued so messages from the same customer are answered in order.',
    receives: ['Customer text messages', 'Button taps such as Confirm, Menu or Talk to staff'],
    sends: ['Message text and the customer’s WhatsApp number, queued for the bot'],
    facts: linked
      ? [
          { label: 'Connection type', value: 'Linked phone (Orderly gateway)' },
          {
            label: 'Status',
            value: connection?.status.replaceAll('_', ' ') ?? 'unknown',
            tone: connection?.status === 'connected' ? 'ok' : 'warn',
          },
          { label: 'Number', value: connection?.phoneNumber || 'Not reported yet' },
          {
            label: 'Last heartbeat',
            value: heartbeatAge === undefined ? 'None yet' : `${heartbeatAge}s ago`,
            tone:
              heartbeatAge !== undefined && heartbeatAge * 1000 < GATEWAY_HEARTBEAT_STALE_MS
                ? 'ok'
                : 'warn',
          },
          {
            label: 'Gateway server',
            value: yes(gatewayAvailable(), 'Configured', 'Not configured'),
            tone: gatewayAvailable() ? 'ok' : 'warn',
          },
        ]
      : [
          {
            label: 'Connection type',
            value: meta?.configured ? 'Meta WhatsApp Cloud API' : 'None yet',
          },
          {
            label: 'Ownership verified',
            value: yes(!!meta?.config.ownershipVerifiedAt),
            tone: meta?.config.ownershipVerifiedAt ? 'ok' : 'muted',
          },
          { label: 'Status', value: meta?.status ?? 'disconnected' },
          ...(mode === 'demo'
            ? [{ label: 'Demo mode', value: 'Never sends real messages', tone: 'muted' as const }]
            : []),
        ],
    affects: [
      'No connection means real customers cannot reach the bot. Use Test your bot meanwhile.',
    ],
    fixed: [
      'Photo, video and document captions and shared locations are read as text; voice notes, stickers and media without a caption go to staff.',
      'A message that arrives more than 10 minutes late is still answered, but an order in it gets a fresh summary to confirm. One more than 2 hours late pauses the bot for that chat; it answers the customer’s next message.',
      'A message that cannot be processed is put in the chat for staff.',
      'Replies are only sent within 24 hours of the customer’s last message.',
      'The same WhatsApp message delivered twice is answered once.',
    ],
    todo: whatsappReady
      ? undefined
      : linked
        ? 'Open Integrations and reconnect or re-pair the linked phone.'
        : 'Open Integrations and connect the business WhatsApp number.',
  };

  const tester: FlowNode = {
    id: 'sandbox',
    title: 'Test your bot',
    subtitle: 'Draft or published settings',
    status: 'ready',
    statusLabel: 'Always available',
    editable: true,
    page: 'playground',
    pageLabel: 'Test your bot',
    what: 'A private chat that runs exactly the same steps as WhatsApp, without sending real messages or writing Sheet rows.',
    receives: ['Messages you type as a pretend customer'],
    sends: ['The same message path, marked as a test'],
    facts: [
      { label: 'Uses', value: 'Saved draft or published version (your choice)' },
      { label: 'Sends WhatsApp messages', value: 'Never', tone: 'muted' },
      { label: 'Writes Sheet rows', value: 'Never', tone: 'muted' },
      {
        label: 'Test orders so far',
        value: `${testOrderCount}${testOrders.total > testOrders.items.length ? '+' : ''}`,
      },
    ],
    affects: ['Test chats use your selected model and its real API key, so they cost a little.'],
    fixed: ['A test chat stops if you change the model or settings mid-chat. Start a new one.'],
  };

  const gates: FlowNode = {
    id: 'gates',
    title: 'Safety checks',
    subtitle: company.botEnabled ? 'Automatic replies on' : 'Automatic replies paused',
    status: company.botEnabled || mode === 'demo' ? 'ready' : 'attention',
    statusLabel: company.botEnabled ? 'Replies on' : 'Paused',
    editable: true,
    page: 'bot',
    pageLabel: 'Bot settings',
    what: 'Decides whether the bot may answer this message at all, before any AI is used.',
    receives: ['The queued customer message', 'The chat’s current mode (bot or staff)'],
    sends: ['Bot path, or a hand-off to staff with a short notice to the customer'],
    facts: [
      {
        label: 'Automatic replies',
        value: company.botEnabled ? 'On' : 'Paused',
        tone: company.botEnabled ? 'ok' : 'warn',
      },
      {
        label: 'AI spending this month',
        value: `${usd(summary.monthlySpend)} of ${usd(ai.monthlyBudgetUsd)}`,
        tone: summary.monthlySpend >= ai.monthlyBudgetUsd * 0.8 ? 'warn' : 'ok',
      },
      { label: 'AI replies per hour', value: `Up to ${limits.repliesPerHour}` },
      {
        label: 'AI replies per customer',
        value: `Up to ${limits.repliesPerCustomerPerHour} an hour`,
      },
    ],
    affects: [
      'When replies are paused, messages are saved for staff and the bot stays quiet.',
      'When the monthly budget, the hourly replies or one customer’s replies run out, that customer gets one short notice, staff can reply, and the bot answers again once the limit resets or you raise it.',
    ],
    fixed: [
      'A chat a staff member has taken over stays with staff until they hand it back.',
      `${limits.messagesPerCustomerPerMinute} messages from one customer within a minute pause the bot for that customer for ${BURST_PAUSE_MS / 60000} minutes.`,
      'If the menu Sheet cannot be read, the menu last read from it is used for up to 12 hours; after that the chat goes to staff.',
      'Messages from a number staff blocked are ignored before they are saved.',
      'Orders from your menu page, and the order codes customers send from it, skip the AI.',
    ],
    todo: company.botEnabled
      ? undefined
      : 'Finish the setup steps, then enable automatic replies in Bot settings.',
  };

  const modelReady = usesAi && keyAvailable && verified && approved && !!rates;
  const connectHint = 'In Bot settings → AI model, click Connect and test.';
  const modelTodo = !usesAi
    ? 'In Bot settings → AI model, choose a provider, paste this business’s API key and click Connect and test.'
    : !keyAvailable
      ? `Paste this business’s ${PROVIDER_NAMES[ai.provider]} API key in Bot settings → AI model and click Connect and test.`
      : !rates
        ? 'Enter this model’s token prices under Advanced in Bot settings → AI model.'
        : !approved
          ? `Tick the data agreement. ${connectHint}`
          : !verified
            ? `The current settings have not been tested. ${connectHint}`
            : undefined;
  const model: FlowNode = {
    id: 'model',
    title: usesAi ? PROVIDER_NAMES[ai.provider] : 'No AI model',
    subtitle: usesAi ? ai.model : 'Local rules only',
    status: modelReady ? 'ready' : 'attention',
    statusLabel: modelReady ? 'Tested' : usesAi ? 'Needs setup' : 'Not selected',
    editable: true,
    page: 'bot',
    pageLabel: 'Bot settings',
    what: 'The language model that reads the customer’s message and proposes what to do next. It never sets prices or saves orders.',
    receives: [
      'Fixed safety and ordering rules',
      'Your bot instructions and rules',
      'Business info, menu index and the relevant menu items',
      'Recent chat history and the current cart',
    ],
    sends: [
      `Up to ${MODEL_LIMITS.maxActions} proposed actions (show menu, add item, set details, review, confirm, hand off, answer)`,
      'A short reply, the question it is asking, and which facts it relied on',
    ],
    facts: [
      { label: 'Provider', value: PROVIDER_NAMES[ai.provider] },
      { label: 'Model', value: ai.model || 'None' },
      { label: 'Who pays', value: 'This business’s API key' },
      { label: 'API key available', value: yes(keyAvailable), tone: keyAvailable ? 'ok' : 'warn' },
      {
        label: 'Generation test',
        value: verified ? 'Passed for this exact model and key' : 'Not run for current settings',
        tone: verified ? 'ok' : 'warn',
      },
      { label: 'Data terms approved', value: yes(approved), tone: approved ? 'ok' : 'warn' },
      {
        label: 'Price per 1M tokens',
        value: rates ? `${usd(rates[0])} in · ${usd(rates[1])} out` : 'Not set',
        tone: rates ? undefined : 'warn',
      },
      { label: 'Thinking', value: profile.summary },
      {
        label: 'Reused instructions',
        value:
          ai.provider !== 'anthropic'
            ? 'Not used with this provider'
            : !promptCacheEnabled()
              ? 'Turned off'
              : ai.model.startsWith('claude-haiku-4-5')
                ? 'Used only when your instructions are very long on this model'
                : 'Anthropic keeps a 5-minute copy of your fixed instructions, so repeat messages cost less. The text the AI reads is unchanged.',
      },
      {
        label: 'Time limit',
        value: `${MODEL_LIMITS.timeoutMs / 1000}s; a busy or unreachable provider is tried again up to ${MODEL_LIMITS.refusedRetries} times within it`,
      },
      {
        label: 'Spent this month',
        value: `${usd(summary.monthlySpend)} of ${usd(ai.monthlyBudgetUsd)}`,
      },
    ],
    affects: [
      'The model is the main reason replies understand (or misunderstand) English, Urdu and Roman Urdu.',
      'Switching provider or model keeps every order rule the same; only understanding and wording change.',
      `If the model fails or times out on WhatsApp, the customer gets a short notice and the bot pauses for that chat; after ${AI_ERROR_PAUSE_MS / 60000} minutes it answers the customer's next message, unless staff reply.`,
    ],
    fixed: [
      'It cannot create orders, set prices, invent menu items, approve orders or claim payment.',
      'Customer text, menu descriptions and answers are treated as data, never as instructions.',
      `Prompts larger than ${MODEL_LIMITS.maxPromptBytes / 1000} KB are refused; shorten long descriptions.`,
    ],
    todo: modelTodo,
  };

  const memory: FlowNode = {
    id: 'memory',
    title: 'Chat memory',
    subtitle: `Last ${MODEL_LIMITS.historyMessages} messages + cart`,
    status: 'fixed',
    statusLabel: 'Built in',
    editable: false,
    what: 'What the bot remembers about this customer’s conversation.',
    receives: ['Saved chat messages', 'The structured cart'],
    sends: ['Recent history and the cart to the model'],
    facts: [
      { label: 'History sent', value: `Last ${MODEL_LIMITS.historyMessages} messages` },
      {
        label: 'Message length kept',
        value: `${MODEL_LIMITS.historyMessageChars.toLocaleString('en-US')} characters each`,
      },
      { label: 'Cart', value: 'Items, options, pickup/delivery and review status' },
      {
        label: 'Customer name and address',
        value:
          'Shown as “[collected]” in the cart; recent messages carry them as the customer wrote them',
      },
    ],
    affects: [
      'The cart, not the chat text, is the source of truth, so long chats never lose items.',
      `Details older than the last ${MODEL_LIMITS.historyMessages} messages are not visible to the model.`,
    ],
    fixed: ['History length and masking are set by Orderly.'],
  };

  const menuNeedsSheet = company.catalogSource === 'sheets' && sheets?.status !== 'connected';
  const menu: FlowNode = {
    id: 'menu',
    title: 'Menu',
    subtitle: `${available.length} of ${products.length} items available`,
    status: available.length && !menuNeedsSheet ? 'ready' : 'attention',
    statusLabel: !available.length ? 'Empty' : menuNeedsSheet ? 'Sheet not tested' : 'In use',
    editable: true,
    page: 'menu',
    pageLabel: 'Menu',
    what: 'Your catalog. Prices always come from here, never from the AI.',
    receives: [
      company.catalogSource === 'sheets'
        ? 'Rows from your Google Sheet'
        : 'Items you add in Orderly',
    ],
    sends: [
      'Every item’s name, category, description, aliases and options (without prices)',
      'Full details with prices for items the customer mentions or already has in the cart',
    ],
    facts: [
      {
        label: 'Source',
        value: company.catalogSource === 'sheets' ? 'Google Sheet' : 'Orderly menu',
      },
      { label: 'Items', value: `${products.length} (${available.length} available)` },
      ...(company.catalogSource === 'sheets'
        ? [{ label: 'Last synced', value: company.catalogSyncedAt ?? 'Never' }]
        : []),
    ],
    affects: [
      'If customers use other names for a dish, add them as aliases so the bot matches them.',
      'Sold-out items are never added to a cart, and the bot won’t swap in a different dish.',
    ],
    fixed: [
      'A Sheet menu is refreshed at most once a minute before the bot answers.',
      'The order engine re-checks every price and option before a quote.',
    ],
    todo: !available.length
      ? 'Add at least one available menu item.'
      : menuNeedsSheet
        ? 'Connect and test the Google Sheet that holds the menu.'
        : undefined,
  };

  const businessComplete = !!company.address && !!company.phone;
  const knowledge: FlowNode = {
    id: 'knowledge',
    title: 'Business info',
    subtitle: `${knowledgeCount} approved answers · ${zones.length} delivery areas`,
    status: businessComplete ? 'ready' : 'attention',
    statusLabel: businessComplete ? 'In use' : 'Incomplete',
    editable: true,
    page: 'settings',
    pageLabel: 'Settings',
    what: 'Facts about your restaurant the bot may repeat, and owner-approved answers to common questions.',
    receives: ['Business settings', 'Approved answers from Settings and Bot settings'],
    sends: ['Name, address, phone, hours, open/closed now, delivery areas and approved answers'],
    facts: [
      {
        label: 'Address',
        value: company.address ? 'Set' : 'Missing',
        tone: company.address ? 'ok' : 'warn',
      },
      {
        label: 'Phone',
        value: company.phone ? 'Set' : 'Missing',
        tone: company.phone ? 'ok' : 'warn',
      },
      {
        label: 'Hours',
        value: `${hours.start}–${hours.end} · ${
          hours.days.length === 7
            ? 'every day'
            : hours.days.map((day) => days[day]).join(', ') || 'no days'
        }`,
      },
      {
        label: 'Open right now',
        value: company.openingHours ? yes(isOpen(company, new Date().toISOString())) : 'Unknown',
      },
      { label: 'Delivery areas', value: String(zones.length) },
      { label: 'Approved answers', value: String(knowledgeCount) },
    ],
    affects: [
      'Questions about hours, address or delivery are answered from these facts only.',
      'An answer that matches an approved question is sent word-for-word, allergy answers included.',
      'If no fact covers a question, the bot says it isn’t sure and hands off to staff. An allergy question without an approved answer gets a fixed safety notice and goes to staff.',
    ],
    fixed: [paymentOptions(company), 'Orders can’t be confirmed while the restaurant is closed.'],
    todo: businessComplete ? undefined : 'Add the business address and phone in Settings.',
  };

  const instructions: FlowNode = {
    id: 'instructions',
    title: 'Instructions & rules',
    subtitle: `${enabledRules.length} rule${enabledRules.length === 1 ? '' : 's'} · ${published.personality}`,
    status: company.bot?.published ? 'ready' : 'attention',
    statusLabel: company.bot?.published
      ? draftChanged
        ? 'Draft not published'
        : 'Published'
      : 'Not published',
    editable: true,
    page: 'bot',
    pageLabel: 'Bot settings',
    what: 'Your published goal, tone, language, flow instructions and behavior rules.',
    receives: ['Your published bot settings'],
    sends: ['Instructions and rules to the model, after Orderly’s fixed rules'],
    facts: [
      {
        label: 'Published version',
        value: company.bot?.published ? `v${company.bot.published.version}` : 'None (defaults)',
      },
      ...(draftChanged
        ? [{ label: 'Draft', value: 'Has unpublished changes', tone: 'warn' as const }]
        : []),
      { label: 'Goal', value: clip(published.goal, 140) },
      {
        label: 'Personality · language',
        value: `${published.personality} · ${published.language === 'auto' ? 'match customer' : published.language}`,
      },
      {
        label: 'Instructions',
        value: published.instructions
          ? `${published.instructions.length.toLocaleString('en-US')} characters`
          : 'None',
      },
      {
        label: 'Rules',
        value: enabledRules.length
          ? enabledRules
              .slice(0, 3)
              .map((rule, index) => `${index + 1}. ${clip(rule.when, 60)} → ${rule.action}`)
              .join(' · ')
          : 'None',
      },
      { label: 'Greeting', value: published.greeting ? 'Custom' : 'Default' },
      { label: 'Handoff message', value: published.handoffMessage ? 'Custom' : 'Default' },
      {
        label: 'Staff phone confirmation',
        value: published.requirePhoneConfirmation ? 'Required before accepting' : 'Not required',
      },
    ],
    affects: [
      'Rules run top to bottom; the first match decides. “Exact” rules are sent word-for-word.',
      'A greeting replaces the reply only for a plain “hi”, “hello” or “salam”.',
      'Live WhatsApp chats use the published version; Test your bot can use the draft.',
    ],
    fixed: ['Orderly’s safety and ordering rules always come first and cannot be overridden.'],
    todo: company.bot?.published ? undefined : 'Save and publish your bot settings.',
  };

  const agent: FlowNode = {
    id: 'agent',
    title: published.name || 'Ordering agent',
    subtitle: company.bot?.published
      ? `Published v${company.bot.published.version}`
      : 'Not published (using defaults)',
    status: modelReady && company.bot?.published ? 'ready' : 'attention',
    statusLabel: modelReady && company.bot?.published ? 'Ready' : 'Needs setup',
    editable: true,
    page: 'bot',
    pageLabel: 'Bot settings',
    what: 'Combines the model, memory, menu, business info and your instructions into one request for each customer message.',
    receives: ['The customer message', 'Everything from the connected parts below'],
    sends: ['The model’s proposed actions and reply to the order rules engine'],
    facts: [
      { label: 'Model', value: usesAi ? `${PROVIDER_NAMES[ai.provider]} · ${ai.model}` : 'None' },
      { label: 'Menu items', value: String(products.length) },
      { label: 'Approved answers', value: String(knowledgeCount) },
      { label: 'Rules', value: String(enabledRules.length) },
    ],
    affects: [
      'Change any connected part and the next message uses it; test chats must be restarted.',
    ],
    fixed: ['Each message is handled on its own with the latest saved settings.'],
    todo: modelTodo ?? (company.bot?.published ? undefined : 'Publish your bot settings.'),
  };

  const engine: FlowNode = {
    id: 'engine',
    title: 'Order rules engine',
    subtitle: 'Checks every proposal',
    status: 'fixed',
    statusLabel: 'Built in',
    editable: false,
    what: 'Orderly’s own code. It validates what the model proposed, calculates prices, and writes the parts of the reply that must be exact.',
    receives: ['Proposed actions and reply text', 'Menu, cart and business settings'],
    sends: [
      'Validated cart changes',
      'Exact item lines, totals and order summaries',
      'The final reply',
    ],
    facts: [
      { label: 'Prices from', value: 'Menu only' },
      { label: 'Actions per message', value: 'Up to 8' },
      { label: 'Quantity', value: '1–50 per item' },
      { label: 'Confirmation', value: 'Customer must confirm the latest summary' },
    ],
    affects: [
      'If the AI picks a different dish than the customer clearly named, the engine corrects it.',
      'AI text that states prices, totals or “order confirmed”, in English, Urdu or Roman Urdu, is dropped; the engine writes those.',
      'If the AI asks for something already collected, its question is ignored.',
    ],
    fixed: [
      'Any change to items, options or delivery needs a fresh summary and confirmation.',
      'Prices and options are re-checked when the order is saved.',
    ],
  };

  const router: FlowNode = {
    id: 'router',
    title: 'What happens next',
    subtitle: 'Reply · order · staff',
    status: 'fixed',
    statusLabel: 'Built in',
    editable: false,
    what: 'Every message gets a reply. A confirmed order is also saved, and a hand-off moves the chat to staff.',
    receives: ['The engine’s result'],
    sends: ['Reply to the customer', 'New pending order', 'Hand-off to staff'],
    facts: [],
    affects: [],
    fixed: ['The reply, the order and its follow-up jobs are saved together, so none is lost.'],
  };

  const reply: FlowNode = {
    id: 'reply',
    title: 'Reply to customer',
    subtitle: whatsappReady ? channelName : 'Test chats only',
    status: whatsappReady ? 'ready' : 'off',
    statusLabel: whatsappReady ? 'Sending' : 'Not sending',
    editable: true,
    page: 'integrations',
    pageLabel: 'Integrations',
    what: 'Sends the final reply back on the same WhatsApp number.',
    receives: ['The final reply text'],
    sends: ['A WhatsApp message (with Confirm and Menu buttons on the Meta connection)'],
    facts: [
      {
        label: 'Delivered by',
        value: linked
          ? 'Linked phone gateway'
          : meta?.configured
            ? 'Meta Cloud API'
            : 'Nothing connected',
      },
      { label: 'Longest message', value: '4,096 characters' },
    ],
    affects: ['Delivery status (sent, delivered, read) appears in the Inbox.'],
    fixed: [
      'A reply is not resent automatically if its delivery result is uncertain.',
      'Bot replies are dropped if staff took over the chat or replies were paused meanwhile. An order confirmation always goes out, because the order exists.',
    ],
  };

  const order: FlowNode = {
    id: 'order',
    title: 'Save order',
    subtitle: 'Pending until staff accept',
    status: 'ready',
    statusLabel: 'Active',
    editable: true,
    page: 'orders',
    pageLabel: 'Orders',
    what: 'A confirmed cart becomes a pending order. Staff accept, prepare and dispatch it in Orders.',
    receives: ['The confirmed cart'],
    sends: ['New order to Orders, the Sheet and the staff bell'],
    facts: [
      {
        label: 'Staff phone confirmation',
        value: published.requirePhoneConfirmation ? 'Required' : 'Not required',
      },
      { label: 'Currency', value: company.currency },
    ],
    affects: ['The bot tells the customer the order is waiting for the restaurant to accept it.'],
    fixed: ['Confirming twice never creates a second order.'],
  };

  const sheetConnected = sheets?.status === 'connected';
  const sheet: FlowNode = {
    id: 'sheets',
    title: 'Google Sheet',
    subtitle: sheetConnected
      ? sheets?.config.ordersSheet || 'Orders tab'
      : sheets?.configured
        ? 'Saved, not tested'
        : 'Not connected',
    status: sheetConnected ? 'ready' : sheets?.configured ? 'attention' : 'off',
    statusLabel: sheetConnected
      ? 'Connected'
      : sheets?.configured
        ? 'Test needed'
        : 'Not connected',
    editable: true,
    page: 'integrations',
    pageLabel: 'Integrations',
    what: 'Copies each real order to your spreadsheet. Orderly stays the record of truth.',
    receives: ['New and updated orders'],
    sends: ['One row per order, updated when its status changes'],
    facts: [
      { label: 'Orders tab', value: sheets?.config.ordersSheet || '—' },
      { label: 'Menu tab', value: sheets?.config.catalogSheet || '—' },
      ...(sheets?.error
        ? [{ label: 'Last error', value: clip(sheets.error, 120), tone: 'warn' as const }]
        : []),
    ],
    affects: [],
    fixed: [
      'Editing a status in the Sheet does not change the order in Orderly.',
      'Test chats never write rows.',
      ...(mode === 'live'
        ? ['Live automatic replies currently require a tested Sheet connection.']
        : []),
    ],
    todo: sheetConnected ? undefined : 'Connect and test the order Sheet in Integrations.',
  };

  const emailAlerts = !!env('RESEND_API_KEY') && !!env('ALERT_FROM_EMAIL');
  const staff: FlowNode = {
    id: 'staff',
    title: 'Staff inbox & alerts',
    subtitle: 'Hand-offs and new orders',
    status: 'ready',
    statusLabel: 'Active',
    editable: true,
    page: 'inbox',
    pageLabel: 'Inbox',
    what: 'Chats that need a person. The bot stays quiet in that chat until staff hand it back.',
    receives: ['Hand-offs, failures and new orders'],
    sends: ['Bell alerts in the dashboard, and optional email reminders'],
    facts: [
      {
        label: 'Email reminders',
        value: emailAlerts ? 'Available (each person opts in)' : 'Not configured on the server',
        tone: emailAlerts ? 'ok' : 'muted',
      },
      { label: 'Browser alerts', value: 'Optional, while the dashboard is open' },
    ],
    affects: ['Your handoff message is what customers see when a chat moves to staff.'],
    fixed: [
      'Staff replies in WhatsApp are also only possible within 24 hours of the customer’s message.',
    ],
  };

  const setup: SetupStep[] = [
    {
      id: 'business',
      title: 'Add business details',
      detail: 'Address, phone, opening hours and delivery areas.',
      done: businessComplete,
      recommended: true,
      page: 'settings',
      action: 'Open Settings',
    },
    {
      id: 'menu',
      title: 'Add your menu',
      detail: 'At least one available item with its price and options.',
      done: available.length > 0,
      page: 'menu',
      action: 'Open Menu',
    },
    {
      id: 'ai',
      title: 'Connect your AI model',
      detail:
        'Bot settings → AI model: choose Anthropic (Claude Haiku 5.5 is recommended), paste this business’s API key, tick the agreement and click Connect and test.',
      done: modelReady,
      page: 'bot',
      action: 'Connect AI model',
    },
    {
      id: 'publish',
      title: 'Publish your bot instructions',
      detail: 'Goal, tone, rules and greeting. Live chats use the published version.',
      done: !!company.bot?.published,
      page: 'bot',
      action: 'Open Bot settings',
    },
    {
      id: 'try',
      title: 'Place a test order',
      detail: 'Order something in Test your bot and accept it in Orders.',
      done: testOrderCount > 0,
      recommended: true,
      page: 'playground',
      action: 'Open Test your bot',
    },
    {
      id: 'whatsapp',
      title: 'Connect WhatsApp',
      detail:
        mode === 'demo'
          ? 'Available on the live server only. The local demo never sends messages.'
          : 'Link the restaurant’s number in Integrations.',
      done: whatsappReady,
      optional: mode === 'demo',
      page: 'integrations',
      action: 'Open Integrations',
    },
    {
      id: 'sheets',
      title: 'Connect the order Sheet',
      detail: 'Share a spreadsheet with the service account and test it.',
      done: ready('sheets'),
      optional: mode === 'demo',
      page: 'integrations',
      action: 'Open Integrations',
    },
    {
      id: 'enable',
      title: 'Turn on automatic replies',
      detail: 'Only after every step above passes.',
      done: company.botEnabled,
      page: 'bot',
      action: 'Open Bot settings',
    },
  ];

  const recent: RecentReply[] = [...live.items, ...sandbox.items]
    .flatMap((conversation) => {
      const message = conversation.messages.at(-1);
      return message?.role === 'assistant' && message.explanation
        ? [
            {
              conversationId: conversation.id,
              channel: conversation.channel,
              customerName: conversation.customerName,
              message: {
                id: message.id,
                text: clip(message.text, 600),
                createdAt: message.createdAt,
                explanation: message.explanation,
              },
            },
          ]
        : [];
    })
    .sort((a, b) => b.message.createdAt.localeCompare(a.message.createdAt))
    .slice(0, 12);

  return {
    generatedAt: new Date().toISOString(),
    mode,
    nodes: [
      channel,
      tester,
      gates,
      agent,
      model,
      memory,
      menu,
      knowledge,
      instructions,
      engine,
      router,
      reply,
      order,
      sheet,
      staff,
    ],
    setup,
    ...(role !== 'staff' && { platform: platformChecks(mode) }),
    recent,
  };
}

function platformChecks(mode: 'demo' | 'live'): PlatformCheck[] {
  const set = (name: string) => !!env(name);
  return [
    {
      id: 'mode',
      label: 'Server mode',
      ok: true,
      detail: mode === 'live' ? 'Live (Supabase)' : 'Local demo: nothing is sent',
    },
    {
      id: 'gateway',
      label: 'WhatsApp linked-phone gateway',
      ok: gatewayAvailable(),
      detail: 'WHATSAPP_GATEWAY_ENABLED, _URL and _SECRET (the Railway service)',
    },
    {
      id: 'meta',
      label: 'Meta WhatsApp app',
      ok: set('META_APP_SECRET') && set('META_VERIFY_TOKEN') && set('META_GRAPH_VERSION'),
      detail: 'META_APP_SECRET, META_VERIFY_TOKEN and META_GRAPH_VERSION (official route)',
    },
    {
      id: 'worker',
      label: 'Background worker secret',
      ok: mode === 'demo' || set('CRON_SECRET'),
      detail: 'CRON_SECRET, so queued messages are processed',
    },
    {
      id: 'encryption',
      label: 'Credential encryption key',
      ok: mode === 'demo' || set('CREDENTIAL_ENCRYPTION_KEY'),
      detail: 'CREDENTIAL_ENCRYPTION_KEY protects saved API keys',
    },
    {
      id: 'email',
      label: 'Staff email reminders',
      ok: set('RESEND_API_KEY') && set('ALERT_FROM_EMAIL'),
      detail: 'RESEND_API_KEY and ALERT_FROM_EMAIL (optional)',
    },
  ];
}
