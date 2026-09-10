export type Language = 'en' | 'ur' | 'roman-ur';
export type Provider = 'mock' | 'openai' | 'anthropic' | 'gemini';
export type Role = 'admin' | 'owner' | 'staff';
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
  ai: { provider: Provider; model: string; keyMode: 'platform' | 'own'; monthlyBudgetUsd: number };
  catalogSyncedAt?: string;
  createdAt: string;
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
  version: number;
  updatedAt: string;
  lastInboundAt: string;
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
}
export interface Trace {
  id: string;
  companyId: string;
  conversationId?: string;
  action: string;
  detail: string;
  createdAt: string;
  durationMs?: number;
}
export interface Usage {
  id: string;
  companyId: string;
  provider: Provider;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  createdAt: string;
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
  usage: Usage[];
  traces: Trace[];
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
  | { type: 'confirm'; revision?: number }
  | { type: 'cancel' }
  | { type: 'new_order' }
  | { type: 'handoff' }
  | { type: 'answer'; text: string };
export interface TurnInput {
  messageId: string;
  text: string;
  action?: BotAction;
  now: string;
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
  kind: 'incoming' | 'whatsapp_send' | 'sheet_sync';
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
