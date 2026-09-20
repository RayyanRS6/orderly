import type {
  Company,
  Conversation,
  Integration,
  IntegrationKind,
  Job,
  Order,
  Product,
  Role,
  Trace,
  Usage,
  ListFilter,
  PageResult,
  WorkspaceSummary,
  TeamMember,
  BotSettings,
  Message,
} from '../src/shared/types';
import { DemoFileRepository, MemoryRepository } from './storage/memory';
import { SupabaseRepository } from './storage/supabase';
import { appMode } from './config';

export interface Repository {
  consumeGatewayNonce(nonce: string): Promise<boolean>;
  getWhatsAppConnection(
    companyId: string,
  ): Promise<import('../src/shared/whatsapp').WhatsAppConnection | undefined>;
  findWhatsAppConnection(
    id: string,
  ): Promise<import('../src/shared/whatsapp').WhatsAppConnection | undefined>;
  saveWhatsAppConnection(
    connection: import('../src/shared/whatsapp').WhatsAppConnection,
    expectedRevision: number,
  ): Promise<boolean>;
  findWhatsAppConversation(
    companyId: string,
    address: import('../src/shared/whatsapp').WhatsAppAddress,
  ): Promise<Conversation | undefined>;
  platformBudget(): Promise<import('../src/shared/types').PlatformBudget>;
  configurePlatformBudget(limit: number): Promise<import('../src/shared/types').PlatformBudget>;
  alertPreferences(
    companyId: string,
    userId: string,
  ): Promise<import('../src/shared/types').AlertPreferences>;
  configureAlerts(
    companyId: string,
    userId: string,
    enabled: boolean,
    minutes: number,
  ): Promise<import('../src/shared/types').AlertPreferences>;
  alertRecipient(companyId: string, userId: string): Promise<string | null>;
  hasOverdueAttention(companyId: string, minutes: number): Promise<boolean>;
  staffAttention(companyId: string): Promise<import('../src/shared/types').StaffAttention>;
  retentionStatus(
    companyId: string,
    previewDays: number,
  ): Promise<import('../src/shared/types').RetentionStatus>;
  configureRetention(
    companyId: string,
    days: number,
    actorId: string,
  ): Promise<import('../src/shared/types').RetentionStatus>;
  recordDelivery(
    companyId: string,
    externalId: string,
    status: NonNullable<Message['delivery']>,
    conversationId?: string,
    messageId?: string,
    error?: string,
  ): Promise<void>;
  audit(companyId: string, actorId: string, action: string): Promise<void>;
  listAllowedCompanies(userId: string): Promise<Company[]>;
  queryOrders(companyId: string, filter: ListFilter): Promise<PageResult<Order>>;
  queryConversations(companyId: string, filter: ListFilter): Promise<PageResult<Conversation>>;
  conversationHistory(companyId: string, id: string, page: number): Promise<PageResult<Message>>;
  getSummary(companyId: string, sandbox: boolean): Promise<WorkspaceSummary>;
  disconnectIntegration(companyId: string, kind: IntegrationKind): Promise<void>;
  listCompanyJobs(companyId: string): Promise<Job[]>;
  saveBot(companyId: string, settings: BotSettings, expectedRevision: number): Promise<boolean>;
  recordCall(
    companyId: string,
    orderId: string,
    confirmation: NonNullable<Order['phoneConfirmation']>,
  ): Promise<Order | undefined>;
  listMembers(companyId: string): Promise<TeamMember[]>;
  setMember(companyId: string, member: TeamMember, actorId: string): Promise<void>;
  removeMember(companyId: string, userId: string, actorId: string): Promise<void>;
  eraseCustomer(companyId: string, phone: string): Promise<number>;
  consumeRateLimit(key: string, limit: number): Promise<boolean>;
  listCompanies(): Promise<Company[]>;
  getCompany(id: string): Promise<Company | undefined>;
  saveCompany(company: Company): Promise<void>;
  getRole(userId: string, companyId: string): Promise<Role | null>;
  isAdmin(userId: string): Promise<boolean>;
  listProducts(companyId: string): Promise<Product[]>;
  saveProduct(product: Product): Promise<void>;
  deleteProduct(companyId: string, id: string): Promise<void>;
  replaceProducts(companyId: string, products: Product[]): Promise<void>;
  listConversations(companyId: string): Promise<Conversation[]>;
  getConversation(companyId: string, id: string): Promise<Conversation | undefined>;
  findConversation(
    companyId: string,
    phone: string,
    channel: Conversation['channel'],
  ): Promise<Conversation | undefined>;
  saveConversation(conversation: Conversation, expectedVersion?: number): Promise<boolean>;
  acquireConversationLock(
    companyId: string,
    conversationId: string,
    ownerId: string,
    leaseUntil: string,
  ): Promise<boolean>;
  releaseConversationLock(
    companyId: string,
    conversationId: string,
    ownerId: string,
  ): Promise<void>;
  listOrders(companyId: string): Promise<Order[]>;
  getOrder(companyId: string, id: string): Promise<Order | undefined>;
  saveOrder(order: Order): Promise<void>;
  updateOrderStatus(
    companyId: string,
    id: string,
    expectedStatus: Order['status'],
    newStatus: Order['status'],
    now: string,
    jobs?: Job[],
    automatedConversation?: Conversation,
  ): Promise<Order | undefined>;
  setOrderSyncStatus(
    companyId: string,
    id: string,
    status: Order['syncStatus'],
    expectedUpdatedAt?: string,
  ): Promise<void>;
  retryFailedJobs(companyId: string): Promise<number>;
  commitTurn(
    companyId: string,
    conversation: Conversation,
    expectedVersion: number,
    order?: Order,
    jobs?: Job[],
    usage?: Usage,
  ): Promise<boolean>;
  getIntegrations(companyId: string): Promise<Integration[]>;
  saveIntegration(
    companyId: string,
    integration: Integration,
    encryptedSecret?: string,
  ): Promise<void>;
  getSecret(companyId: string, kind: IntegrationKind): Promise<string | undefined>;
  addTrace(trace: Trace): Promise<void>;
  listTraces(companyId: string): Promise<Trace[]>;
  addUsage(usage: Usage): Promise<void>;
  listUsage(companyId: string): Promise<Usage[]>;
  reserveBudget(
    companyId: string,
    reservationId: string,
    amountUsd: number,
    expiresAt: string,
  ): Promise<boolean>;
  settleBudget(reservationId: string, usage: Usage): Promise<void>;
  insertJob(job: Job, dedupeKey?: string): Promise<boolean>;
  getJob(id: string): Promise<Job | undefined>;
  listDueJobs(limit: number): Promise<Job[]>;
  claimJob(id: string, now: string, leaseUntil: string): Promise<Job | undefined>;
  saveJob(job: Job): Promise<void>;
  findCompanyByPhoneNumberId(id: string): Promise<Company | undefined>;
}

export { DemoFileRepository, MemoryRepository, SupabaseRepository };

export function createRepository(): Repository {
  const mode = appMode();
  if (mode === 'demo') return new DemoFileRepository();
  if (mode !== 'live') throw new Error('APP_MODE must be demo or live.');
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key)
    throw new Error('Live mode requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  return new SupabaseRepository(url, key);
}
