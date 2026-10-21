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
/** A way a customer may pay the restaurant. Orderly itself takes no payments. */
export type PaymentMethod = 'cash' | 'jazzcash' | 'easypaisa' | 'bank_transfer';
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
  /**
   * How customers may pay the restaurant. Missing or empty means cash only. Orderly never
   * collects or sends account numbers: for a transfer the customer is told to type "staff", and
   * restaurant staff send the payment details and confirm the transfer themselves.
   */
  paymentMethods?: PaymentMethod[];
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
  /**
   * Counts settings saves (PUT /api/companies/:id and Connect and test), so a save sent from an
   * older copy of the settings is refused instead of undoing a newer change. Missing means 0.
   */
  settingsRevision?: number;
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
  /** Set only on a deal turned into a menu entry at sell time (shared/deals.ts). */
  deal?: ProductDeal;
}
/** One pick in a deal's choice group, e.g. "Sprite". price = extra charge in paisa (0 = free). */
export interface DealChoiceOption {
  id: string;
  name: string;
  price: number;
}
/** A choice the customer must make for a deal, e.g. "Drink". Exactly one option is picked. */
export interface DealChoiceGroup {
  id: string;
  name: string;
  options: DealChoiceOption[];
}
/** One thing a deal includes. productId (+ variantId for a size) links a menu item: optional. */
export interface DealItem {
  name: string;
  quantity: number;
  productId?: string;
  variantId?: string;
}
/** When a deal can be ordered, in the restaurant's timezone. Same day rule as opening hours. */
export interface DealSchedule {
  /**
   * 0 = Sunday … 6 = Saturday, 1..7 unique. A listed day is the calendar day a window STARTS
   * (isOpen's rule): start > end crosses midnight and its after-midnight part belongs to the
   * listed start day.
   */
  days: number[];
  /** 'HH:MM'. start === end means all day on the listed days. */
  start: string;
  /** 'HH:MM'. */
  end: string;
  /** 'YYYY-MM-DD' inclusive, compared with the occurrence date (shared/hours.ts). */
  startDate?: string;
  /** 'YYYY-MM-DD' inclusive, compared with the occurrence date (shared/hours.ts). */
  endDate?: string;
}
/** A combo or time-limited offer. Kept in its own table, never in `products`. */
export interface Deal {
  /** A uuid, never equal to any product id: products and deals share one id space. */
  id: string;
  companyId: string;
  /** "Deal 1", "Zinger Lunch Deal". */
  name: string;
  description: string;
  /** Default '🎁'. */
  emoji: string;
  /** An https photo link, as for products. */
  imageUrl?: string;
  aliases: string[];
  /** The deal price, in paisa. */
  price: number;
  /**
   * The owner's "price if bought separately". "You save" = regularPrice - price, shown only when
   * above 0. Never worked out at sell time.
   */
  regularPrice?: number;
  /** What's included, 1..20. */
  items: DealItem[];
  /** 0..5 groups of 2..25 options. Ids are unique across the deal. */
  choices: DealChoiceGroup[];
  /** The owner's on/off ("Paused" when false). */
  available: boolean;
  /** Missing means whenever the restaurant is open. */
  schedule?: DealSchedule;
  /** Order on the menu: ascending, ties by name (numeric collation). */
  position: number;
  updatedAt: string;
}
export type DealState = 'on' | 'later' | 'sold_out' | 'paused' | 'ended';
/** Present only on product-shaped deal entries built at sell time; never stored in `products`. */
export interface ProductDeal {
  /** `${quantity} × ${name}` from the deal's STORED item names. */
  includes: string[];
  choices: DealChoiceGroup[];
  regularPrice?: number;
  state: DealState;
  /** English wording of when it is on, time-aware; for the menu page, the AI and the dashboard. */
  when?: string;
  /**
   * Internal, so the engine can word the times in the chat's language. Never sent to the public
   * menu or the AI.
   */
  schedule?: DealSchedule;
}
export interface CartItem {
  productId: string;
  quantity: number;
  /** Never set for a deal. */
  variantId?: string;
  /**
   * For a deal line: the chosen option id of each choice group, one per group. Their order means
   * nothing (stored sorted, like extras): show picks in the deal's group order instead.
   */
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
  /** The bot reply that showed the review this cart awaits confirmation against, and when. */
  reviewMessageId?: string;
  reviewedAt?: string;
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
  /** Messages one customer may send within a minute before the bot pauses for them. */
  messagesPerCustomerPerMinute?: number;
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
  // When staff last took the chat over themselves (Inbox → Take over). A customer waiting for
  // staff counts as waiting from then at the earliest, not from an older message the bot answered.
  humanSince?: string;
  // Set when an AI limit stopped the bot answering this chat. Staff see it under "Needs staff";
  // the bot takes the chat back after `until`, or once the limit is raised, unless staff wrote.
  // 'burst' (too many messages at once), 'ai_error' (the AI could not answer) and 'late' (the
  // message reached Orderly hours late) end only at `until`.
  limitPause?: {
    reason: AiLimitKind | 'burst' | 'ai_error' | 'late';
    at: string;
    until: string;
    limit: number;
  };
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
  /**
   * The bot asked which option the customer wants for the deal's next unpicked choice group.
   * Cleared wherever pendingItemChoice is. `groupId` and `optionIds` are the choice and its
   * options as last shown, so a number answers the list the customer saw (absent on choices
   * asked before they were kept). `more`: while it waits behind a dish's "which one?", other deals
   * in that message were not added, so its question, once asked, says "Then tell me the next deal."
   */
  pendingDealChoice?: {
    productId: string;
    quantity: number;
    picked: string[];
    notes: string;
    groupId?: string;
    optionIds?: string[];
    more?: boolean;
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
// The steps: pending → preparing (Accept) → ready (pickup) or out_for_delivery (delivery) →
// completed. 'accepted' is from before Accept went straight to 'preparing': an older order may
// still have it, and it moves on to 'preparing'.
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
  /** On a deal line: its picks in group order, "Drink: Sprite, Side: Fries"; absent with none. */
  variant?: string;
  modifiers: string[];
  notes: string;
  total: number;
  /** Deal lines only, always there ([] with no choice groups): the picks in group order. */
  choices?: { group: string; option: string }[];
  /** Deal lines only, always there: what the deal includes ("1 × Fries"). Marks a deal line. */
  includes?: string[];
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
  /** Staff's own note about the order (such as what the customer said on the phone), saved with a status change. */
  staffNote?: { text: string; at: string; actorId: string };
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
  /** Orders waiting at each step staff act on ('preparing' includes older 'accepted' ones). */
  stages?: OrderStageCounts;
}
export interface OrderStageCounts {
  pending: number;
  preparing: number;
  ready: number;
  out_for_delivery: number;
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
  /** Linked phones that stopped working while the bot is on. Missing from older servers. */
  whatsapp?: number;
  items: {
    id: string;
    /** 'whatsapp': a linked phone stopped working (entityId is the connection). */
    kind: 'order' | 'handoff' | 'job' | 'budget' | 'limit' | 'whatsapp';
    entityId: string;
    createdAt: string;
    /**
     * For 'limit': which limit, and when the bot answers again. 'hourly_near': 80% of this
     * hour's AI replies are used (a warning, not counted in `limits`).
     */
    scope?: 'monthly' | 'hourly' | 'hourly_near';
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
  /** Missing from servers older than deals. */
  deals?: Deal[];
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
  /**
   * Set when a queued message is processed more than 10 minutes late: it is answered, but a
   * confirmation in it gets a fresh order summary to confirm instead of placing the order. One
   * more than 2 hours late gets no answer: the chat pauses for staff to see it, and the bot
   * answers the customer's next message.
   */
  late?: boolean;
  /**
   * Server only, with `late`: when the message was actually processed. A review shown in the
   * reply is stamped with this time, so the customer's next on-time "confirm" finds it fresh.
   */
  receivedAt?: string;
  /** Server only: the public menu page URL when it is on, for menu replies and {menu_link}. */
  menuLink?: string;
  /** Server only: the app's own web host, always allowed in AI wording. */
  appHost?: string;
  /** Server only: the order this chat placed, for a status question. */
  latestOrder?: Pick<Order, 'reference' | 'status' | 'fulfillment' | 'createdAt' | 'updatedAt'>;
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
  kind: 'incoming' | 'whatsapp_send' | 'sheet_sync' | 'staff_alert' | 'order_followup';
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
