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
  AiCallReservation,
  AiLimitStatus,
  BlockedCustomer,
  Account,
  Membership,
} from '../src/shared/types';
import type {
  MenuDraft,
  MenuDraftInput,
  MenuDraftResult,
  MenuLink,
  WebOrderClaim,
  WebOrderOutcome,
} from '../src/shared/menu';
import { DemoFileRepository, MemoryRepository } from './storage/memory';
import { SupabaseRepository } from './storage/supabase';
import { appMode } from './config';

/** Whether saved work is being processed (SQL orderly_pipeline_health). Server-only. */
export interface PipelineHealth {
  /** 'unconfigured': the worker or the minute's recovery is not set up, so nothing is sent. */
  status: 'ok' | 'stalled' | 'unconfigured';
  /** Jobs due over 3 minutes ago that recovery would still send. */
  stalledJobs: number;
  oldestDueAt: string | null;
  schedulerConfigured: boolean;
  recoveryScheduled: boolean;
  lastRecoverRun: { status: string; at: string } | null;
  /** Worker calls in the last 15 minutes that failed or were refused; null when unknown. */
  recentWorkerErrors: number | null;
  dbSizeBytes: number;
}

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
  // For an outside monitor, across all businesses. Fails with 503 before its migration.
  pipelineHealth(): Promise<PipelineHealth>;
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
  // Sign-in accounts (Supabase Auth). Server-only. Emails go only to owners (their own team)
  // and the platform admin.
  listAccounts(): Promise<Account[]>;
  // Missing or unreadable accounts are left out.
  getAccounts(userIds: string[]): Promise<Account[]>;
  // Trimmed, case-insensitive.
  findAccountByEmail(email: string): Promise<Account | undefined>;
  // Sends the Supabase invitation and returns the new user ID.
  inviteAccount(email: string): Promise<string>;
  // Hard delete: memberships, the admin row and alert settings cascade.
  deleteAccount(userId: string): Promise<void>;
  listAllMemberships(): Promise<Membership[]>;
  listAdminIds(): Promise<string[]>;
  eraseCustomer(companyId: string, phone: string): Promise<number>;
  // What eraseCustomer would remove for this number, for a complete export: every chat it
  // matches (by the same rule) and the orders placed in them, newest first. Messages are the
  // chat's recent ones; conversationHistory has them all. Fails with 503 before its migration.
  customerRecords(
    companyId: string,
    phone: string,
  ): Promise<{ conversations: Conversation[]; orders: Order[] }>;
  // For a customer known only by a chat (WhatsApp shared no number, a privacy ID): erases that
  // chat, every chat with its number when it has one and every WhatsApp chat with its privacy ID
  // or number on the linked phone, as eraseCustomer erases a number's. 0 when the chat is gone.
  eraseConversation(companyId: string, conversationId: string): Promise<number>;
  // What eraseConversation would remove, as customerRecords for a number. Fails with 503 before
  // its migration.
  conversationRecords(
    companyId: string,
    conversationId: string,
  ): Promise<{ conversations: Conversation[]; orders: Order[] }>;
  consumeRateLimit(key: string, limit: number): Promise<boolean>;
  listCompanies(): Promise<Company[]>;
  getCompany(id: string): Promise<Company | undefined>;
  saveCompany(company: Company): Promise<void>;
  // Sets only catalogSyncedAt, and only forwards, leaving every other setting untouched.
  markCatalogSynced(companyId: string, syncedAt: string): Promise<void>;
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
    // Saved as order.staffNote with the change. Fails with 503 before 202610200003_order_flow.sql.
    note?: Order['staffNote'],
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
  // Holds the cost of one AI call if the monthly budget allows it and, for a live customer
  // chat (conversationId set), if the restaurant's hourly replies and that customer's replies
  // since customerSince (at most the last hour) are under their limits.
  reserveAiCall(
    companyId: string,
    reservationId: string,
    amountUsd: number,
    expiresAt: string,
    conversationId?: string,
    customerSince?: string,
  ): Promise<AiCallReservation>;
  settleBudget(reservationId: string, usage: Usage): Promise<void>;
  aiLimitStatus(companyId: string): Promise<AiLimitStatus>;
  // Blocks every key and marks the conversation blocked, together. Returns the conversation.
  blockCustomer(
    companyId: string,
    conversationId: string,
    blockId: string,
    keys: string[],
    label: string,
    actorId: string,
  ): Promise<Conversation>;
  // Removes the block and clears the mark on its conversations; false when it was not found.
  unblockCustomer(companyId: string, blockId: string): Promise<boolean>;
  // The block matching any key, counting the ignored message. Undefined when not blocked.
  findBlockedCustomer(companyId: string, keys: string[]): Promise<string | undefined>;
  listBlockedCustomers(companyId: string): Promise<BlockedCustomer[]>;
  insertJob(job: Job, dedupeKey?: string): Promise<boolean>;
  getJob(id: string): Promise<Job | undefined>;
  // Whether a reply written before this one to the same customer is still unsent: pending,
  // or processing under a lease that ends after activeLeaseAfter (a recent claim).
  hasEarlierSend(
    companyId: string,
    conversationId: string,
    job: Job,
    activeLeaseAfter: string,
  ): Promise<boolean>;
  listDueJobs(limit: number): Promise<Job[]>;
  claimJob(id: string, now: string, leaseUntil: string): Promise<Job | undefined>;
  saveJob(job: Job): Promise<void>;
  findCompanyByPhoneNumberId(id: string): Promise<Company | undefined>;
  // Public menu page. Before its migration, reads find no link (the page is off).
  getMenuLink(companyId: string): Promise<MenuLink | undefined>;
  findMenuLink(slug: string): Promise<MenuLink | undefined>;
  // Turns the link on or off. The slug is used only the first time; it never changes after.
  setMenuLink(companyId: string, enabled: boolean, slug: string): Promise<MenuLink>;
  // Saves a menu-page order (insert only) and uses up its personal link or order code, together.
  placeWebOrder(
    companyId: string,
    conversation: Conversation,
    expectedVersion: number,
    order: Order,
    jobs: Job[],
    claim: WebOrderClaim,
  ): Promise<WebOrderOutcome>;
  findMenuLinkUse(
    companyId: string,
    nonce: string,
  ): Promise<{ orderId: string; conversationId: string } | undefined>;
  // Read-only: never counts a hit or adds identities, unlike findBlockedCustomer.
  hasBlockedKey(companyId: string, keys: string[]): Promise<boolean>;
  // Refuses past maxOpen open drafts per business ('busy') or 15 per network address
  // ('busy_source'). A number's older open drafts end when it makes a new one.
  createMenuDraft(
    draft: MenuDraftInput,
    minutes: number,
    maxOpen: number,
  ): Promise<MenuDraftResult>;
  findMenuDraft(companyId: string, codeHash: string): Promise<MenuDraft | undefined>;
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
