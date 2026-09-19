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
  ai: {
    provider: Provider;
    model: string;
    keyMode: 'platform' | 'own';
    monthlyBudgetUsd: number;
    pricing?: [number, number];
  };
  catalogSyncedAt?: string;
  createdAt: string;
  bot?: BotSettings;
  privacy?: { aiDataApproved: boolean; retentionDays: number };
  modelVerification?: { fingerprint: string; checkedAt: string };
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
}
export interface Conversation {
  id: string;
  companyId: string;
  customerPhone: string;
  customerName: string;
  channel: 'demo' | 'whatsapp';
  language: Language;
  mode: 'bot' | 'human';
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
    keyMode: 'platform' | 'own';
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
  funding?: 'platform' | 'own';
  id: string;
  companyId: string;
  provider: Provider;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  createdAt: string;
  conversationId?: string;
  sandbox?: boolean;
  estimated?: boolean;
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
}
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
  items: {
    id: string;
    kind: 'order' | 'handoff' | 'job' | 'budget';
    entityId: string;
    createdAt: string;
  }[];
}
export interface AlertPreferences {
  enabled: boolean;
  responseMinutes: number;
  emailVerified: boolean;
  available?: boolean;
}
export interface PlatformBudget {
  limitUsd: number;
  spentUsd: number;
  reservedUsd: number;
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
    keyMode: 'platform' | 'own';
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
}
export interface TurnInput {
  messageId: string;
  text: string;
  action?: BotAction;
  now: string;
  testTarget?: 'draft' | 'published';
}
export interface TurnResult {
  conversation: Conversation;
  order?: Order;
  reply: string;
  traces: string[];
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
