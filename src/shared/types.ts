export type Language = 'en' | 'ur' | 'roman-ur';
export type Provider = 'mock' | 'openai' | 'anthropic' | 'gemini';
export type Role = 'admin' | 'owner' | 'staff';
export interface BehaviorRule {
  id: string;
  enabled: boolean;
  when: string;
  action: 'continue' | 'reply' | 'handoff';
  response: string;
  responseMode: 'exact' | 'adaptive';
}
export interface BotConfig {
  name: string;
  personality: 'warm' | 'professional' | 'concise';
  language: 'auto' | Language;
  goal: string;
  instructions: string;
  knowledge: { question: string; answer: string }[];
  greeting: string;
  handoffMessage: string;
  behaviorRules: BehaviorRule[];
  fulfillment: 'both' | 'pickup' | 'delivery';
  requirePhoneConfirmation: boolean;
}
export interface BotVersion {
  version: number;
  config: BotConfig;
  publishedAt: string;
  publishedBy: string;
}
export interface BotSettings {
  draft: BotConfig;
  published?: BotVersion;
  history: BotVersion[];
  revision: number;
}
export interface DeliveryZone {
  name: string;
  fee: number;
}
export interface Company {
  id: string;
  name: string;
  slug: string;
  address: string;
  phone: string;
  timezone: string;
  currency: 'PKR';
  botEnabled: boolean;
  catalogSource: 'app' | 'sheets';
  openingHours: { start: string; end: string; days: number[] };
  deliveryZones: DeliveryZone[];
  faqs: { question: string; answer: string }[];
  // Every business answers with its own provider API key (Bot settings → AI model).
  ai: {
    provider: Provider;
    model: string;
    monthlyBudgetUsd: number;
    pricing?: [number, number];
  };
  // Spam protection on top of the monthly budget. Missing values use AI_LIMIT_DEFAULTS. Kept
  // outside `ai`, which connecting a model or turning AI off rebuilds from scratch.
  aiLimits?: AiLimits;
  catalogSyncedAt?: string;
  createdAt: string;
  bot?: BotSettings;
  privacy?: { aiDataApproved: boolean; retentionDays: number; aiApproval?: AiDataApproval };
  modelVerification?: { fingerprint: string; checkedAt: string };
  /** Set only by the Orderly admin: this business may pair a new linked phone. */
  linkedDeviceAllowed?: boolean;
}
/** Who accepted the AI data terms, for which provider, and what they confirmed. */
export interface AiDataApproval {
  provider: Provider;
  userId: string;
  at: string;
  /** The version of the terms text that was accepted. */
  version: string;
  /** No data-sharing or model-training opt-in is turned on for the provider account. */
  noTrainingOptIn: boolean;
  /** The key's Google Cloud project has billing on (paid tier). Required for Gemini. */
  paidTierAttested: boolean;
}
export interface ProductOption {
  id: string;
  name: string;
  price: number;
}
export interface Product {
  id: string;
  companyId: string;
  name: string;
  description: string;
  category: string;
  price: number;
  available: boolean;
  emoji: string;
  aliases: string[];
  variants: ProductOption[];
  modifiers: ProductOption[];
  /** An https photo link for the menu page. Never sent to the AI. */
  imageUrl?: string;
}
export interface CartItem {
  productId: string;
  quantity: number;
  variantId?: string;
  modifierIds: string[];
  notes: string;
}
export interface Cart {
  items: CartItem[];
  fulfillment?: 'pickup' | 'delivery';
  customerName?: string;
  address?: string;
  zone?: string;
  revision: number;
  reviewedRevision?: number;
  quoteHash?: string;
  quotedTotal?: number;
  status: 'building' | 'awaiting_confirmation' | 'submitted' | 'cancelled';
  orderId?: string;
}
export interface Message {
  id: string;
  role: 'customer' | 'assistant' | 'staff';
  text: string;
  createdAt: string;
  delivery?: 'accepted' | 'sent' | 'delivered' | 'read' | 'failed';
  deliveryError?: string;
  externalId?: string;
  /** Why the bot sent this reply. Present on bot replies written by this version onward. */
  explanation?: TurnExplanation;
  /** An automatic notice (such as an order status change), not something staff wrote. */
  notice?: boolean;
}
/** Who wrote each part of a bot reply. */
export type ReplyPart =
  | 'engine'
  | 'approved_answer'
  | 'model'
  | 'exact_rule'
  | 'greeting'
  | 'handoff_message'
  | 'fallback'
  | 'notice';
/** What happened to the text the AI model wrote. */
export type ModelTextOutcome =
  | 'used'
  | 'none'
  | 'replaced'
  | 'exact_rule'
  | 'protected'
  | 'staff_mode'
  | 'ungrounded'
  | 'invalid_question'
  | 'unsafe';
/** Engine-side facts about how a reply was assembled. */
export interface ReplyDecision {
  parts: ReplyPart[];
  modelText: ModelTextOutcome;
  matchedRule?: Pick<BehaviorRule, 'id' | 'when' | 'action' | 'responseMode'>;
  corrections: string[];
}
export type ModelSkipReason =
  'button' | 'late' | 'local_rules' | 'staff_mode' | 'paused' | 'cancellation' | 'menu_page';
// 'ai_budget' is the monthly AI spending limit; 'hourly_limit' and 'customer_limit' are the
// AI replies per hour for the whole restaurant and for one customer.
export type StaffNoticeCause =
  'burst' | 'menu_sync' | 'ai_error' | 'ai_budget' | 'hourly_limit' | 'customer_limit';
export interface AiLimits {
  /** AI replies per clock hour across all live customers. */
  repliesPerHour?: number;
  /** AI replies one customer may receive within an hour. */
  repliesPerCustomerPerHour?: number;
}
export type AiLimitKind = 'monthly' | 'hourly' | 'customer';
export interface TurnExplanation {
  v: 1;
  channel: 'demo' | 'whatsapp';
  config: { target: 'draft' | 'published' | 'live'; revision: number; version?: number };
  provider: Provider;
  model: string;
  catalogSource: 'app' | 'sheets';
  ai: {
    called: boolean;
    skipped?: ModelSkipReason;
    proposed?: { type: BotAction['type']; productId?: string; quantity?: number }[];
    askFor?: ModelResponse['askFor'];
    groundingIds?: string[];
    ruleOverride?: 'handoff' | 'reply';
    usage?: {
      inputTokens: number;
      /** Prompt tokens reused from the provider's cache (Anthropic). Part of inputTokens. */
      cacheReadTokens?: number;
      /** Prompt tokens saved to the provider's cache (Anthropic). Part of inputTokens. */
      cacheWriteTokens?: number;
      outputTokens: number;
      costUsd: number;
      durationMs: number;
      estimated: boolean;
    };
  };
  steps: string[];
  decision: ReplyDecision;
  outcome: 'reply' | 'order' | 'staff';
  orderReference?: string;
  notice?: StaffNoticeCause;
}
export interface Conversation {
  whatsappAddress?: import('./whatsapp').WhatsAppAddress;
  id: string;
  companyId: string;
  customerPhone: string;
  customerName: string;
  channel: 'demo' | 'whatsapp';
  language: Language;
  mode: 'bot' | 'human';
  // Set when the chat went to staff only because the bot was switched off. The bot
  // takes it back once switched on; any staff action or handoff request clears it.
  botPausedAt?: string;
  // When staff last handed the chat back to the bot. A staff phone message older than this
  // (replayed after the gateway reconnects) is recorded but does not take the chat back.
  botResumedAt?: string;
  // Set when an AI limit stopped the bot answering this chat. Staff see it under "Needs staff";
  // the bot takes the chat back after `until`, or once the limit is raised, unless staff wrote.
  limitPause?: { reason: AiLimitKind; at: string; until: string; limit: number };
  // When this customer was last told about a limit: at most one such notice an hour.
  limitNoticeAt?: string;
  // When the bot last took the chat back after a per-customer pause. Replies counted toward the
  // customer limit start here, so the customer gets a full allowance again.
  limitResumedAt?: string;
  // Staff blocked this customer's number. Their messages are dropped before they are saved.
  blocked?: { at: string; blockId: string };
  messages: Message[];
  cart: Cart;
  pendingItemChoice?: {
    candidateProductIds: string[];
    quantity: number;
    requestedOptionNames: string[];
    notes: string;
    originalText: string;
  };
  testContext?: {
    target: 'draft' | 'published';
    configRevision: number;
    provider: Provider;
    model: string;
    catalogSource: 'app' | 'sheets';
  };
  version: number;
  updatedAt: string;
  lastInboundAt: string;
  botVersion?: number;
  assignedTo?: string;
  readAt?: string;
}
export type OrderStatus =
  | 'pending'
  | 'accepted'
  | 'preparing'
  | 'ready'
  | 'out_for_delivery'
  | 'completed'
  | 'rejected'
  | 'cancelled';
export interface OrderLine {
  productId: string;
  name: string;
  quantity: number;
  unitPrice: number;
  variant?: string;
  modifiers: string[];
  notes: string;
  total: number;
}
export interface Order {
  id: string;
  companyId: string;
  conversationId: string;
  reference: string;
  submissionKey: string;
  customerName: string;
  customerPhone: string;
  fulfillment: 'pickup' | 'delivery';
  address?: string;
  zone?: string;
  items: OrderLine[];
  subtotal: number;
  deliveryFee: number;
  total: number;
  currency: 'PKR';
  status: OrderStatus;
  syncStatus: 'not_connected' | 'pending' | 'synced' | 'failed';
  createdAt: string;
  updatedAt: string;
  sandbox?: boolean;
  phoneConfirmationRequired?: boolean;
  phoneConfirmation?: {
    outcome: 'confirmed' | 'unreachable' | 'declined';
    addressVerified: boolean;
    note: string;
    at: string;
    actorId: string;
  };
  /** Placed on the public menu page (/m/<slug>) instead of in the chat. */
  source?: 'menu_page';
}
export interface Trace {
  id: string;
  companyId: string;
  conversationId?: string;
  action: string;
  detail: string;
  createdAt: string;
  durationMs?: number;
  actorId?: string;
  model?: string;
  botVersion?: number;
  code?: string;
}
export interface Usage {
  id: string;
  companyId: string;
  provider: Provider;
  model: string;
  inputTokens: number;
  /** Prompt tokens reused from the provider's cache (Anthropic). Part of inputTokens. */
  cacheReadTokens?: number;
  /** Prompt tokens saved to the provider's cache (Anthropic). Part of inputTokens. */
  cacheWriteTokens?: number;
  outputTokens: number;
  costUsd: number;
  createdAt: string;
  conversationId?: string;
  sandbox?: boolean;
  estimated?: boolean;
  /** The provider refused the request before answering, so it cost nothing. */
  rejected?: boolean;
}
export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
export interface ListFilter {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: string;
  sandbox?: boolean;
  from?: string;
  to?: string;
}
export interface WorkspaceSummary {
  orders: number;
  pending: number;
  value: number;
  conversations: number;
  needsStaff: number;
  monthlySpend: number;
  daily: { date: string; count: number }[];
}
export interface ReadinessCheck {
  id: string;
  label: string;
  ready: boolean;
  /** Advice that never blocks automation, such as terms to confirm again. */
  warning?: string;
}
export interface ModelOption {
  id: string;
  name: string;
  available: boolean;
  priced: boolean;
  inputRate?: number;
  outputRate?: number;
  verified?: boolean;
}
export interface TeamMember {
  userId: string;
  role: 'owner' | 'staff';
  email?: string;
  /** Has an account but has never signed in (invitation not used yet). */
  waiting?: boolean;
  /** This row is the person viewing the list. */
  you?: boolean;
}
/** A sign-in account from Supabase Auth. Read on the server only. */
export interface Account {
  userId: string;
  email?: string;
  createdAt?: string;
  lastSignInAt?: string;
  /** Invited, never signed in. */
  invited?: boolean;
}
export interface Membership {
  companyId: string;
  userId: string;
  role: 'owner' | 'staff';
}
export interface PeopleAccount extends Account {
  admin: boolean;
  you?: boolean;
  memberships: { companyId: string; role: 'owner' | 'staff' }[];
}
export interface PeopleDirectory {
  businesses: { id: string; name: string; slug: string }[];
  accounts: PeopleAccount[];
  /** Supabase Auth could not be read; people show by account ID. */
  emailsUnavailable?: boolean;
  /** False until the admin's session is authenticator-verified. */
  canDeleteAccounts: boolean;
}
export type AddMemberOutcome = 'added' | 'added_waiting' | 'invited';
export interface RetentionStatus {
  days: number;
  eligibleAfter: string | null;
  lastRunAt: string | null;
  lastDeleted: number;
  eligibleConversations: number;
}
export interface StaffAttention {
  total: number;
  orders: number;
  handoffs: number;
  failures: number;
  budgets: number;
  /** Missing from servers older than the AI limits. */
  limits?: number;
  items: {
    id: string;
    kind: 'order' | 'handoff' | 'job' | 'budget' | 'limit';
    entityId: string;
    createdAt: string;
    /** For 'limit': which limit, and when the bot answers again. */
    scope?: 'monthly' | 'hourly';
    resetsAt?: string;
  }[];
}
export interface AiLimitStatus {
  repliesThisHour: number;
  repliesPerHour: number;
  repliesPerCustomerPerHour: number;
  hourResetsAt: string;
}
export interface BlockedCustomer {
  blockId: string;
  label: string;
  keys: string[];
  conversationId?: string;
  blockedBy?: string;
  createdAt: string;
  blockedCount: number;
  lastBlockedAt?: string;
}
export type AiCallReservation =
  | { ok: true }
  | {
      ok: false;
      limit: 'duplicate' | AiLimitKind;
      resetAt?: string;
      limitValue?: number;
    };
export interface AlertPreferences {
  enabled: boolean;
  responseMinutes: number;
  emailVerified: boolean;
  available?: boolean;
}
export type IntegrationKind = 'whatsapp' | 'sheets' | 'openai' | 'anthropic' | 'gemini';
export interface Integration {
  kind: IntegrationKind;
  configured: boolean;
  status: 'disconnected' | 'configured' | 'connected' | 'error';
  label?: string;
  checkedAt?: string;
  error?: string;
  config: Record<string, string>;
}
export interface Bootstrap {
  mode: 'demo' | 'live';
  role: Role;
  company: Company;
  companies: Company[];
  products: Product[];
  orders: Order[];
  conversations: Conversation[];
  integrations: Integration[];
  aiConnection: {
    provider: Provider;
    configured: boolean;
  };
  usage: Usage[];
  traces: Trace[];
  summary?: WorkspaceSummary;
  readiness?: ReadinessCheck[];
  jobs?: Job[];
}
export type BotAction =
  | { type: 'menu'; query?: string }
  | {
      type: 'add_item';
      productId: string;
      quantity: number;
      variantId?: string;
      modifierIds?: string[];
      notes?: string;
    }
  | { type: 'remove_item'; productId: string }
  | {
      type: 'set_details';
      fulfillment?: 'pickup' | 'delivery';
      customerName?: string;
      address?: string;
      zone?: string;
    }
  | { type: 'review' }
  | { type: 'cart_summary' }
  | { type: 'confirm'; revision?: number }
  | { type: 'cancel' }
  | { type: 'new_order' }
  | { type: 'handoff' }
  | {
      type: 'clarify_item';
      candidateProductIds: string[];
      quantity: number;
      requestedOptionNames?: string[];
      notes?: string;
      originalText?: string;
    }
  | { type: 'answer'; text: string };
export interface ModelResponse {
  text: string;
  askFor?: 'items' | 'fulfillment' | 'name' | 'zone' | 'address' | 'anything_else' | 'none';
  matchedRuleId?: string;
  groundingIds?: string[];
}
export interface ModelInterpretation {
  actions: BotAction[];
  response?: ModelResponse;
  usage?: NonNullable<TurnExplanation['ai']['usage']>;
}
export interface TurnInput {
  messageId: string;
  text: string;
  action?: BotAction;
  now: string;
  testTarget?: 'draft' | 'published';
  /** Set when a queued message was processed too late and is handed to staff instead. */
  late?: boolean;
  /** Server only: the public menu page URL when it is on, for menu replies and {menu_link}. */
  menuLink?: string;
  /** Server only: the app's own web host, always allowed in AI wording. */
  appHost?: string;
}
export interface TurnResult {
  conversation: Conversation;
  order?: Order;
  reply: string;
  traces: string[];
  decision?: ReplyDecision;
  explanation?: TurnExplanation;
}
export interface Job {
  id: string;
  companyId: string;
  kind: 'incoming' | 'whatsapp_send' | 'sheet_sync' | 'staff_alert';
  payload: Record<string, unknown>;
  status: 'pending' | 'processing' | 'done' | 'failed';
  attempts: number;
  nextRunAt: string;
  error?: string;
  leaseUntil?: string;
  createdAt: string;
}
export const money = (minor: number) =>
  `Rs. ${new Intl.NumberFormat('en-PK', { maximumFractionDigits: 2 }).format(minor / 100)}`;
