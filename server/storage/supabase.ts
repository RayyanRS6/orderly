import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
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
} from '../../src/shared/types';
import type {
  MenuDraft,
  MenuDraftInput,
  MenuDraftResult,
  MenuLink,
  WebOrderClaim,
  WebOrderOutcome,
} from '../../src/shared/menu';
import type { PipelineHealth, Repository } from '../repository';
import { LAST_OWNER_MESSAGE, PublicError } from '../security';
import { env } from '../config';

type Result<T> = { data: T | null; error: { message: string } | null };
function unwrap<T>(result: Result<T>): T | null {
  if (result.error) throw new Error(`Database operation failed: ${result.error.message}`);
  return result.data;
}
// A function or table the hand-applied migrations have not created yet.
const migrationMissing = (error: { code?: string } | null) =>
  ['PGRST202', '42883', '42P01', 'PGRST205'].includes(error?.code ?? '');
const spamMigrationError = () =>
  new PublicError('Apply the spam protection database migration first.', 503);
const warned = new Set<string>();
function warnOnce(name: string, migration = '202610180001_spam_protection.sql') {
  if (warned.has(name)) return;
  warned.add(name);
  console.warn(`Orderly: ${name} is missing. Apply ${migration}.`);
}
// Named arguments shared with the SQL tests, so a renamed parameter fails there too.
export const reserveAiCallArgs = (
  companyId: string,
  reservationId: string,
  amountUsd: number,
  expiresAt: string,
  conversationId?: string,
  customerSince?: string,
) => ({
  p_company_id: companyId,
  p_reservation_id: reservationId,
  p_amount_usd: amountUsd,
  p_expires_at: expiresAt,
  p_conversation_id: conversationId ?? null,
  p_customer_since: customerSince ?? null,
});
export const blockCustomerArgs = (
  companyId: string,
  conversationId: string,
  blockId: string,
  keys: string[],
  label: string,
  actorId: string,
) => ({
  p_company_id: companyId,
  p_conversation_id: conversationId,
  p_block_id: blockId,
  p_keys: keys,
  p_label: label,
  p_actor_id: actorId,
});
// Businesses saved before every business used its own key carry a "keyMode" label. It
// means nothing now; dropping it keeps dashboards opened before that change from seeing
// their test chats as out of date.
function withoutKeyLabel(company: Company): Company {
  const { keyMode: _label, ...ai } = company.ai as Company['ai'] & { keyMode?: unknown };
  return { ...company, ai };
}
const jobRow = (job: Job) => ({
  id: job.id,
  company_id: job.companyId,
  data: job,
  status: job.status,
  next_run_at: job.nextRunAt,
  lease_until: job.leaseUntil ?? null,
  attempts: job.attempts,
  created_at: job.createdAt,
});
const toAccount = (u: User): Account => ({
  userId: u.id,
  email: u.email || undefined,
  createdAt: u.created_at,
  lastSignInAt: u.last_sign_in_at || undefined,
  invited: !u.last_sign_in_at && !!u.invited_at,
});
const accountsUnavailable = () =>
  new PublicError('Couldn’t load accounts from Supabase right now. Try again in a minute.', 502);

/** All methods run on the server using the service role; API authorization is required. */
export class SupabaseRepository implements Repository {
  consumeGatewayNonce(nonce: string) {
    return this.rpc<boolean>('consume_gateway_nonce', { p_nonce: nonce });
  }
  async getWhatsAppConnection(companyId: string) {
    const result = await this.client
      .from('whatsapp_connections')
      .select('data')
      .eq('company_id', companyId)
      .maybeSingle();
    // The existing deployment workflow does not apply migrations. Keep legacy
    // Meta running until the operator migrates, but never bypass other failures.
    if (
      env('WHATSAPP_GATEWAY_ENABLED') !== 'true' &&
      ['42P01', 'PGRST205'].includes(result.error?.code ?? '')
    )
      return;
    const row = unwrap(result) as {
      data: import('../../src/shared/whatsapp').WhatsAppConnection;
    } | null;
    return row?.data;
  }
  findWhatsAppConnection(id: string) {
    return this.get<import('../../src/shared/whatsapp').WhatsAppConnection>(
      'whatsapp_connections',
      id,
    );
  }
  async saveWhatsAppConnection(
    connection: import('../../src/shared/whatsapp').WhatsAppConnection,
    expectedRevision: number,
  ) {
    const result = await this.client.rpc('save_whatsapp_connection', {
      p_connection: connection,
      p_expected_revision: expectedRevision,
    });
    if (['PGRST202', '42883', '42P01'].includes(result.error?.code ?? ''))
      throw new PublicError(
        'Apply the WhatsApp gateway database migration before changing connection methods.',
        503,
      );
    return unwrap(result) as boolean;
  }
  async findWhatsAppConversation(
    companyId: string,
    address: import('../../src/shared/whatsapp').WhatsAppAddress,
  ) {
    const row = unwrap(
      await this.client
        .from('conversations')
        .select('data')
        .eq('company_id', companyId)
        .eq('channel', 'whatsapp')
        .contains('data', { whatsappAddress: address })
        .maybeSingle(),
    ) as { data: Conversation } | null;
    return row?.data;
  }
  alertPreferences(companyId: string, userId: string) {
    return this.rpc<import('../../src/shared/types').AlertPreferences>('alert_preferences', {
      p_company_id: companyId,
      p_user_id: userId,
    });
  }
  configureAlerts(companyId: string, userId: string, enabled: boolean, minutes: number) {
    return this.rpc<import('../../src/shared/types').AlertPreferences>('configure_alerts', {
      p_company_id: companyId,
      p_user_id: userId,
      p_enabled: enabled,
      p_minutes: minutes,
    });
  }
  alertRecipient(companyId: string, userId: string) {
    return this.rpc<string | null>('alert_recipient', {
      p_company_id: companyId,
      p_user_id: userId,
    });
  }
  hasOverdueAttention(companyId: string, minutes: number) {
    return this.rpc<boolean>('has_overdue_attention', {
      p_company_id: companyId,
      p_minutes: minutes,
    });
  }
  staffAttention(companyId: string) {
    return this.rpc<import('../../src/shared/types').StaffAttention>('staff_attention', {
      p_company_id: companyId,
    });
  }
  async pipelineHealth() {
    const result = await this.client.rpc('orderly_pipeline_health');
    if (migrationMissing(result.error))
      throw new PublicError(
        'Apply the 202610200001_prelaunch_fixes.sql database migration first.',
        503,
      );
    return unwrap(result) as PipelineHealth;
  }
  retentionStatus(companyId: string, previewDays: number) {
    return this.rpc<import('../../src/shared/types').RetentionStatus>('retention_status', {
      p_company_id: companyId,
      p_preview_days: previewDays,
    });
  }
  configureRetention(companyId: string, days: number, actorId: string) {
    return this.rpc<import('../../src/shared/types').RetentionStatus>('configure_retention', {
      p_company_id: companyId,
      p_days: days,
      p_actor_id: actorId,
    });
  }
  async recordDelivery(
    companyId: string,
    externalId: string,
    status: NonNullable<Message['delivery']>,
    conversationId?: string,
    messageId?: string,
    error?: string,
  ) {
    await this.rpc('record_delivery', {
      p_company_id: companyId,
      p_external_id: externalId,
      p_status: status,
      p_conversation_id: conversationId ?? null,
      p_message_id: messageId ?? null,
      p_error: error ?? null,
    });
  }
  private async messagesWithReceipts(companyId: string, id: string, messages: Message[]) {
    if (!messages.length) return messages;
    const rows =
      unwrap(
        await this.client
          .from('message_deliveries')
          .select('message_id,external_id,status,error')
          .eq('company_id', companyId)
          .eq('conversation_id', id)
          .in(
            'message_id',
            messages.map((m) => m.id),
          ),
      ) ?? [];
    // A real WhatsApp receipt outranks a "not sent" note ('job:' key) from a failed attempt.
    const receipts = new Map<string, (typeof rows)[number]>();
    for (const r of rows)
      if (!receipts.get(r.message_id) || receipts.get(r.message_id)!.external_id.startsWith('job:'))
        receipts.set(r.message_id, r);
    return messages.map((m) => {
      const r = receipts.get(m.id);
      return r
        ? {
            ...m,
            externalId: r.external_id.startsWith('job:') ? undefined : r.external_id,
            delivery: r.status as Message['delivery'],
            deliveryError: r.error ?? undefined,
          }
        : m;
    });
  }
  async audit(companyId: string, actorId: string, action: string) {
    await this.rpc('audit_event', {
      p_company_id: companyId,
      p_actor_id: actorId,
      p_action: action,
    });
  }
  async listAllowedCompanies(userId: string) {
    if (await this.isAdmin(userId)) return this.listCompanies();
    const memberships =
      unwrap(
        await this.client.from('company_memberships').select('company_id').eq('user_id', userId),
      ) ?? [];
    if (!memberships.length) return [];
    const rows =
      unwrap(
        await this.client
          .from('companies')
          .select('data')
          .in(
            'id',
            memberships.map((m) => m.company_id),
          ),
      ) ?? [];
    return rows.map((row) => withoutKeyLabel(row.data as Company));
  }
  queryOrders(companyId: string, filter: ListFilter) {
    return this.rpc<PageResult<Order>>('query_orders', {
      p_company_id: companyId,
      p_filter: filter,
    });
  }
  queryConversations(companyId: string, filter: ListFilter) {
    return this.rpc<PageResult<Conversation>>('query_conversations', {
      p_company_id: companyId,
      p_filter: filter,
    });
  }
  async conversationHistory(companyId: string, id: string, page: number) {
    const result = await this.rpc<PageResult<Message>>('conversation_history', {
      p_company_id: companyId,
      p_id: id,
      p_page: page,
    });
    result.items = await this.messagesWithReceipts(companyId, id, result.items);
    return result;
  }
  getSummary(companyId: string, sandbox: boolean) {
    return this.rpc<WorkspaceSummary>('workspace_summary', {
      p_company_id: companyId,
      p_sandbox: sandbox,
    });
  }
  async disconnectIntegration(companyId: string, kind: IntegrationKind) {
    await this.rpc('disconnect_integration', { p_company_id: companyId, p_kind: kind });
  }
  async listCompanyJobs(companyId: string) {
    const rows =
      unwrap(
        await this.client
          .from('jobs')
          .select('data')
          .eq('company_id', companyId)
          .neq('status', 'done')
          .order('created_at', { ascending: false })
          .limit(100),
      ) ?? [];
    return rows.map((r) => r.data as Job);
  }
  saveBot(companyId: string, settings: BotSettings, expectedRevision: number) {
    return this.rpc<boolean>('save_bot', {
      p_company_id: companyId,
      p_settings: settings,
      p_revision: expectedRevision,
    });
  }
  async recordCall(
    companyId: string,
    orderId: string,
    confirmation: NonNullable<Order['phoneConfirmation']>,
  ) {
    return (
      (await this.rpc<Order | null>('record_call', {
        p_company_id: companyId,
        p_id: orderId,
        p_confirmation: confirmation,
      })) ?? undefined
    );
  }
  async listMembers(companyId: string): Promise<TeamMember[]> {
    const rows =
      unwrap(
        await this.client
          .from('company_memberships')
          .select('user_id,role')
          .eq('company_id', companyId),
      ) ?? [];
    return rows.map((r) => ({ userId: r.user_id, role: r.role }));
  }
  async setMember(companyId: string, member: TeamMember, actorId: string) {
    await this.manageMember(companyId, member.userId, member.role, actorId);
  }
  async removeMember(companyId: string, userId: string, actorId: string) {
    await this.manageMember(companyId, userId, null, actorId);
  }
  // The last-owner rule and an unknown account become friendly errors instead of the
  // generic "service could not complete" message.
  private async manageMember(
    companyId: string,
    userId: string,
    role: 'owner' | 'staff' | null,
    actorId: string,
  ) {
    const result = await this.client.rpc('manage_member', {
      p_company_id: companyId,
      p_user_id: userId,
      p_role: role,
      p_actor_id: actorId,
    });
    if (result.error?.message?.includes('Keep another owner'))
      throw new PublicError(LAST_OWNER_MESSAGE, 409);
    if (result.error?.code === '23503')
      throw new PublicError(
        'No Orderly account has this ID. Add people by their email instead.',
        404,
      );
    unwrap(result);
  }
  async listAccounts() {
    const out: Account[] = [];
    for (let page = 1; page <= 20; page++) {
      let result: Awaited<ReturnType<SupabaseClient['auth']['admin']['listUsers']>>;
      try {
        result = await this.client.auth.admin.listUsers({ page, perPage: 1000 });
      } catch {
        throw accountsUnavailable();
      }
      if (result.error) throw accountsUnavailable();
      out.push(...result.data.users.map(toAccount));
      // auth-js 2.116.0 keeps only the first digit of the next page number
      // (GoTrueAdminApi.js:448): use it as yes/no only.
      if (!result.data.users.length || !result.data.nextPage) return out;
    }
    throw new PublicError('There are too many accounts to list here.', 413);
  }
  async getAccounts(userIds: string[]) {
    const ids = [...new Set(userIds)];
    if (!ids.length) return [];
    if (ids.length > 25) {
      const wanted = new Set(ids);
      return (await this.listAccounts()).filter((a) => wanted.has(a.userId));
    }
    // If Auth is down, this returns no accounts instead of failing.
    const accounts = await Promise.all(
      ids.map((id) =>
        this.client.auth.admin.getUserById(id).then(
          (r) => (r.error || !r.data.user ? undefined : toAccount(r.data.user)),
          () => undefined,
        ),
      ),
    );
    return accounts.filter((a): a is Account => !!a);
  }
  async findAccountByEmail(email: string) {
    const wanted = email.trim().toLowerCase();
    return (await this.listAccounts()).find((a) => a.email?.toLowerCase() === wanted);
  }
  async inviteAccount(email: string) {
    let userId: string | undefined;
    try {
      const result = await this.client.auth.admin.inviteUserByEmail(email.trim(), {
        redirectTo: `${env('APP_URL')}/login`,
      });
      userId = result.error ? undefined : result.data.user?.id;
    } catch {
      userId = undefined;
    }
    if (!userId)
      throw new PublicError(
        'The invitation couldn’t be sent. Check the email address, and the email settings in Supabase.',
        409,
      );
    return userId;
  }
  async deleteAccount(userId: string) {
    let error: unknown;
    try {
      // Never soft-delete: the auth.users row must go so memberships and settings cascade.
      ({ error } = await this.client.auth.admin.deleteUser(userId));
    } catch (e) {
      error = e;
    }
    if (!error) return;
    if ((error as { status?: number }).status === 404)
      throw new PublicError('This account no longer exists.', 404);
    throw new PublicError(
      'This account couldn’t be deleted. Try again, or check the Supabase Auth logs.',
      502,
    );
  }
  async listAllMemberships() {
    const out: Membership[] = [];
    for (let start = 0; ; start += 1000) {
      const rows =
        unwrap(
          await this.client
            .from('company_memberships')
            .select('company_id,user_id,role')
            .order('company_id')
            .order('user_id')
            .range(start, start + 999),
        ) ?? [];
      out.push(
        ...rows.map((r: { company_id: string; user_id: string; role: 'owner' | 'staff' }) => ({
          companyId: r.company_id,
          userId: r.user_id,
          role: r.role,
        })),
      );
      if (rows.length < 1000) break;
    }
    return out;
  }
  async listAdminIds() {
    return (unwrap(await this.client.from('platform_admins').select('user_id')) ?? []).map(
      (r: { user_id: string }) => r.user_id,
    );
  }
  eraseCustomer(companyId: string, phone: string) {
    return this.rpc<number>('erase_customer', { p_company_id: companyId, p_phone: phone });
  }
  async customerRecords(companyId: string, phone: string) {
    const result = await this.client.rpc('customer_records', {
      p_company_id: companyId,
      p_phone: phone,
    });
    // An export that silently missed chats would look complete: refuse until the SQL is there.
    if (migrationMissing(result.error))
      throw new PublicError(
        'Apply the 202610200001_prelaunch_fixes.sql database migration first.',
        503,
      );
    return unwrap(result) as { conversations: Conversation[]; orders: Order[] };
  }
  consumeRateLimit(key: string, limit: number) {
    return this.rpc<boolean>('consume_rate_limit', { p_key: key, p_limit: limit });
  }
  private client: SupabaseClient;
  constructor(url: string, serviceRoleKey: string) {
    this.client = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: (input, init) =>
          fetch(input, {
            ...init,
            signal: init?.signal
              ? AbortSignal.any([init.signal, AbortSignal.timeout(10000)])
              : AbortSignal.timeout(10000),
          }),
      },
    });
  }
  private async rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    return unwrap(await this.client.rpc(name, args)) as T;
  }
  private async list<T>(
    table: string,
    companyId?: string,
    orderBy?: string,
    limit = 1000,
  ): Promise<T[]> {
    let query = this.client.from(table).select('data');
    if (companyId) query = query.eq('company_id', companyId);
    if (orderBy) query = query.order(orderBy, { ascending: false });
    return (unwrap(await query.limit(limit)) ?? []).map((row: { data: T }) => row.data);
  }
  private async get<T>(table: string, id: string, companyId?: string): Promise<T | undefined> {
    let query = this.client.from(table).select('data').eq('id', id);
    if (companyId) query = query.eq('company_id', companyId);
    const row = unwrap(await query.maybeSingle()) as { data: T } | null;
    return row?.data;
  }
  async listCompanies() {
    return (await this.list<Company>('companies')).map(withoutKeyLabel);
  }
  async getCompany(id: string) {
    const company = await this.get<Company>('companies', id);
    return company && withoutKeyLabel(company);
  }
  async saveCompany(company: Company) {
    await this.rpc('save_company_settings', { p_company: company });
  }
  async markCatalogSynced(companyId: string, syncedAt: string) {
    await this.rpc('mark_catalog_synced', { p_company_id: companyId, p_synced_at: syncedAt });
  }
  async isAdmin(userId: string) {
    return !!unwrap(
      await this.client
        .from('platform_admins')
        .select('user_id')
        .eq('user_id', userId)
        .maybeSingle(),
    );
  }
  async getRole(userId: string, companyId: string): Promise<Role | null> {
    if (await this.isAdmin(userId)) return 'admin';
    const row = unwrap(
      await this.client
        .from('company_memberships')
        .select('role')
        .eq('user_id', userId)
        .eq('company_id', companyId)
        .maybeSingle(),
    ) as { role: Role } | null;
    return (row?.role as Role | undefined) ?? null;
  }
  listProducts(companyId: string) {
    return this.list<Product>('products', companyId);
  }
  async saveProduct(product: Product) {
    unwrap(
      await this.client
        .from('products')
        .upsert({ id: product.id, company_id: product.companyId, data: product }),
    );
  }
  async deleteProduct(companyId: string, id: string) {
    unwrap(await this.client.from('products').delete().eq('company_id', companyId).eq('id', id));
  }
  async replaceProducts(companyId: string, products: Product[]) {
    await this.rpc('replace_products', { p_company_id: companyId, p_products: products });
  }
  listConversations(companyId: string) {
    return this.list<Conversation>('conversations', companyId, 'updated_at', 200);
  }
  async getConversation(companyId: string, id: string) {
    const c = await this.get<Conversation>('conversations', id, companyId);
    if (c) c.messages = await this.messagesWithReceipts(companyId, id, c.messages);
    return c;
  }
  async findConversation(companyId: string, phone: string, channel: Conversation['channel']) {
    const row = unwrap(
      await this.client
        .from('conversations')
        .select('data')
        .eq('company_id', companyId)
        .eq('customer_phone', phone)
        .eq('channel', channel)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ) as { data: Conversation } | null;
    return row?.data as Conversation | undefined;
  }
  saveConversation(conversation: Conversation, expectedVersion?: number) {
    return this.rpc<boolean>('save_conversation', {
      p_conversation: conversation,
      p_expected_version: expectedVersion ?? null,
    });
  }
  acquireConversationLock(
    companyId: string,
    conversationId: string,
    ownerId: string,
    leaseUntil: string,
  ) {
    return this.rpc<boolean>('acquire_conversation_lock', {
      p_company_id: companyId,
      p_conversation_id: conversationId,
      p_owner_id: ownerId,
      p_lease_until: leaseUntil,
    });
  }
  async releaseConversationLock(companyId: string, conversationId: string, ownerId: string) {
    await this.rpc('release_conversation_lock', {
      p_company_id: companyId,
      p_conversation_id: conversationId,
      p_owner_id: ownerId,
    });
  }
  listOrders(companyId: string) {
    return this.list<Order>('orders', companyId, 'created_at', 500);
  }
  getOrder(companyId: string, id: string) {
    return this.get<Order>('orders', id, companyId);
  }
  async saveOrder(order: Order) {
    unwrap(
      await this.client.from('orders').upsert({
        id: order.id,
        company_id: order.companyId,
        conversation_id: order.conversationId,
        submission_key: order.submissionKey,
        data: order,
        created_at: order.createdAt,
        updated_at: order.updatedAt,
      }),
    );
  }
  async updateOrderStatus(
    companyId: string,
    id: string,
    expectedStatus: Order['status'],
    newStatus: Order['status'],
    now: string,
    jobs: Job[] = [],
    automatedConversation?: Conversation,
  ) {
    return (
      (await this.rpc<Order | null>('update_order_status', {
        p_company_id: companyId,
        p_id: id,
        p_expected_status: expectedStatus,
        p_new_status: newStatus,
        p_now: now,
        p_jobs: jobs,
        p_conversation: automatedConversation ?? null,
        p_expected_version: automatedConversation ? automatedConversation.version - 1 : null,
      })) ?? undefined
    );
  }
  async setOrderSyncStatus(
    companyId: string,
    id: string,
    status: Order['syncStatus'],
    expectedUpdatedAt?: string,
  ) {
    await this.rpc('set_order_sync_status', {
      p_company_id: companyId,
      p_id: id,
      p_status: status,
      p_expected_updated_at: expectedUpdatedAt ?? null,
    });
  }
  retryFailedJobs(companyId: string) {
    return this.rpc<number>('retry_failed_jobs', { p_company_id: companyId });
  }
  commitTurn(
    companyId: string,
    conversation: Conversation,
    expectedVersion: number,
    order?: Order,
    jobs: Job[] = [],
    usage?: Usage,
  ) {
    return this.rpc<boolean>('commit_turn', {
      p_company_id: companyId,
      p_conversation: conversation,
      p_expected_version: expectedVersion,
      p_order: order ?? null,
      p_jobs: jobs,
      p_usage: usage ?? null,
    });
  }
  async getIntegrations(companyId: string) {
    return (
      unwrap(await this.client.from('integrations').select('data').eq('company_id', companyId)) ??
      []
    ).map((row: { data: Integration }) => row.data);
  }
  async saveIntegration(companyId: string, integration: Integration, encryptedSecret?: string) {
    const result = await this.client.rpc('save_integration', {
      p_company_id: companyId,
      p_integration: integration,
      p_encrypted_secret: encryptedSecret ?? null,
    });
    if (
      result.error?.code === '23505' &&
      result.error.message.includes('integrations_sheet_destination_unique')
    )
      throw new PublicError(
        'That orders spreadsheet tab is already assigned to another company. Choose a different spreadsheet or orders tab.',
        409,
      );
    unwrap(result);
  }
  async getSecret(companyId: string, kind: IntegrationKind) {
    const row = unwrap(
      await this.client
        .from('integration_secrets')
        .select('encrypted_secret')
        .eq('company_id', companyId)
        .eq('kind', kind)
        .maybeSingle(),
    ) as { encrypted_secret: string } | null;
    return row?.encrypted_secret as string | undefined;
  }
  async addTrace(trace: Trace) {
    unwrap(
      await this.client.from('traces').upsert({
        id: trace.id,
        company_id: trace.companyId,
        conversation_id: trace.conversationId ?? null,
        data: trace,
        created_at: trace.createdAt,
      }),
    );
  }
  async listTraces(companyId: string) {
    const [traces, audit] = await Promise.all([
      this.list<Trace>('traces', companyId, 'created_at', 100),
      this.client
        .from('audit_events')
        .select('id,actor_id,action,created_at')
        .eq('company_id', companyId)
        .order('created_at', { ascending: false })
        .limit(100),
    ]);
    return [
      ...traces,
      ...(unwrap(audit) ?? []).map(
        (row) =>
          ({
            id: `audit-${row.id}`,
            companyId,
            actorId: row.actor_id,
            action: row.action,
            detail: 'Administrative change',
            createdAt: row.created_at,
          }) as Trace,
      ),
    ]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 200);
  }
  async addUsage(usage: Usage) {
    await this.rpc('record_usage', { p_usage: usage });
  }
  async listUsage(companyId: string): Promise<Usage[]> {
    // Usage must not truncate at PostgREST's default 1,000-row limit: it drives cost display.
    const result: Usage[] = [];
    for (let start = 0; ; start += 1000) {
      const rows =
        unwrap(
          await this.client
            .from('usage_events')
            .select('data')
            .eq('company_id', companyId)
            .order('created_at', { ascending: false })
            .order('id')
            .range(start, start + 999),
        ) ?? [];
      result.push(...rows.map((row: { data: Usage }) => row.data));
      if (rows.length < 1000) break;
    }
    return result;
  }
  async reserveAiCall(
    companyId: string,
    reservationId: string,
    amountUsd: number,
    expiresAt: string,
    conversationId?: string,
    customerSince?: string,
  ): Promise<AiCallReservation> {
    const result = await this.client.rpc(
      'reserve_ai_call',
      reserveAiCallArgs(
        companyId,
        reservationId,
        amountUsd,
        expiresAt,
        conversationId,
        customerSince,
      ),
    );
    if (migrationMissing(result.error)) {
      // Only the monthly budget applies until the spam protection migration is applied.
      warnOnce('reserve_ai_call');
      const reserved = await this.rpc<boolean>('reserve_budget', {
        p_company_id: companyId,
        p_reservation_id: reservationId,
        p_amount_usd: amountUsd,
        p_expires_at: expiresAt,
      });
      return reserved ? { ok: true } : { ok: false, limit: 'monthly' };
    }
    return unwrap(result) as AiCallReservation;
  }
  async settleBudget(reservationId: string, usage: Usage) {
    await this.rpc('settle_budget', { p_reservation_id: reservationId, p_usage: usage });
  }
  async aiLimitStatus(companyId: string) {
    const result = await this.client.rpc('ai_limit_status', { p_company_id: companyId });
    if (migrationMissing(result.error)) throw spamMigrationError();
    return unwrap(result) as AiLimitStatus;
  }
  async blockCustomer(
    companyId: string,
    conversationId: string,
    blockId: string,
    keys: string[],
    label: string,
    actorId: string,
  ) {
    const result = await this.client.rpc(
      'block_customer',
      blockCustomerArgs(companyId, conversationId, blockId, keys, label, actorId),
    );
    if (migrationMissing(result.error)) throw spamMigrationError();
    return unwrap(result) as Conversation;
  }
  async unblockCustomer(companyId: string, blockId: string) {
    const result = await this.client.rpc('unblock_customer', {
      p_company_id: companyId,
      p_block_id: blockId,
    });
    if (migrationMissing(result.error)) throw spamMigrationError();
    return unwrap(result) as boolean;
  }
  async findBlockedCustomer(companyId: string, keys: string[]) {
    if (!keys.length) return undefined;
    const result = await this.client.rpc('blocked_customer_hit', {
      p_company_id: companyId,
      p_keys: keys,
    });
    // Incoming messages are never lost to a missing migration: nobody is blocked yet then.
    if (migrationMissing(result.error)) {
      warnOnce('blocked_customer_hit');
      return undefined;
    }
    return (unwrap(result) as string | null) ?? undefined;
  }
  async listBlockedCustomers(companyId: string) {
    const result = await this.client.rpc('list_blocked_customers', { p_company_id: companyId });
    if (migrationMissing(result.error)) throw spamMigrationError();
    return unwrap(result) as BlockedCustomer[];
  }
  insertJob(job: Job, dedupeKey?: string) {
    return this.rpc<boolean>('insert_job', { p_job: job, p_dedupe_key: dedupeKey ?? null });
  }
  getJob(id: string) {
    return this.get<Job>('jobs', id);
  }
  listDueJobs(limit: number) {
    return this.rpc<Job[]>('list_due_jobs', { p_limit: Math.min(Math.max(limit, 1), 100) });
  }
  async claimJob(id: string, now: string, leaseUntil: string) {
    return (
      (await this.rpc<Job | null>('claim_job', {
        p_id: id,
        p_now: now,
        p_lease_until: leaseUntil,
      })) ?? undefined
    );
  }
  async saveJob(job: Job) {
    unwrap(await this.client.from('jobs').upsert(jobRow(job)));
  }
  async hasEarlierSend(
    companyId: string,
    conversationId: string,
    job: Job,
    activeLeaseAfter: string,
  ) {
    const rows =
      unwrap(
        await this.client
          .from('jobs')
          .select('id')
          .eq('company_id', companyId)
          .or(
            `status.eq.pending,and(status.eq.processing,lease_until.gt."${new Date(activeLeaseAfter).toISOString()}")`,
          )
          .eq('data->>kind', 'whatsapp_send')
          .eq('data->payload->>conversationId', conversationId)
          .lt('created_at', job.createdAt)
          .neq('id', job.id)
          .limit(1),
      ) ?? [];
    return rows.length > 0;
  }
  async findCompanyByPhoneNumberId(id: string) {
    const row = unwrap(
      await this.client
        .from('integrations')
        .select('company_id')
        .eq('kind', 'whatsapp')
        .eq('phone_number_id', id)
        .maybeSingle(),
    ) as { company_id: string } | null;
    return row ? this.getCompany(row.company_id as string) : undefined;
  }
  // Public menu page. A missing table means the link is off until the migration is applied.
  getMenuLink(companyId: string) {
    return this.menuLinkWhere('company_id', companyId);
  }
  findMenuLink(slug: string) {
    return this.menuLinkWhere('slug', slug);
  }
  private async menuLinkWhere(column: 'company_id' | 'slug', value: string) {
    const result = await this.client
      .from('menu_links')
      .select('company_id,slug,enabled,updated_at')
      .eq(column, value)
      .maybeSingle();
    if (migrationMissing(result.error)) {
      warnOnce('menu_links', '202610190001_menu_page.sql');
      return undefined;
    }
    const row = unwrap(result) as {
      company_id: string;
      slug: string;
      enabled: boolean;
      updated_at: string;
    } | null;
    return row
      ? {
          companyId: row.company_id,
          slug: row.slug,
          enabled: row.enabled,
          updatedAt: row.updated_at,
        }
      : undefined;
  }
  async setMenuLink(companyId: string, enabled: boolean, slug: string) {
    const result = await this.client.rpc('set_menu_link', {
      p_company_id: companyId,
      p_enabled: enabled,
      p_slug: slug,
    });
    if (migrationMissing(result.error))
      throw new PublicError('Apply the menu page database migration first.', 503);
    return unwrap(result) as MenuLink;
  }
  async placeWebOrder(
    companyId: string,
    conversation: Conversation,
    expectedVersion: number,
    order: Order,
    jobs: Job[],
    claim: WebOrderClaim,
  ) {
    const result = await this.client.rpc(
      'place_web_order',
      placeWebOrderArgs(companyId, conversation, expectedVersion, order, jobs, claim),
    );
    if (migrationMissing(result.error)) throw orderingMigrationError();
    return unwrap(result) as WebOrderOutcome;
  }
  async findMenuLinkUse(companyId: string, nonce: string) {
    const result = await this.client
      .from('menu_link_uses')
      .select('order_id,conversation_id')
      .eq('company_id', companyId)
      .eq('nonce', nonce)
      .maybeSingle();
    if (migrationMissing(result.error)) {
      warnOnce('menu_link_uses', '202610190002_menu_ordering.sql');
      return undefined;
    }
    const row = unwrap(result) as { order_id: string; conversation_id: string } | null;
    return row ? { orderId: row.order_id, conversationId: row.conversation_id } : undefined;
  }
  async hasBlockedKey(companyId: string, keys: string[]) {
    if (!keys.length) return false;
    const result = await this.client
      .from('blocked_customers')
      .select('block_id')
      .eq('company_id', companyId)
      .in('key', keys)
      .limit(1);
    // Nobody can be blocked before the spam protection migration.
    if (migrationMissing(result.error)) return false;
    return (unwrap(result) ?? []).length > 0;
  }
  async createMenuDraft(draft: MenuDraftInput, minutes: number, maxOpen: number) {
    const result = await this.client.rpc(
      'create_menu_draft',
      createMenuDraftArgs(draft, minutes, maxOpen),
    );
    if (migrationMissing(result.error)) throw orderingMigrationError();
    return unwrap(result) as MenuDraftResult;
  }
  async findMenuDraft(companyId: string, codeHash: string) {
    const result = await this.client
      .from('menu_drafts')
      .select(
        'id,company_id,phone_hash,cart,quoted_total,expires_at,used_at,order_id,conversation_id',
      )
      .eq('company_id', companyId)
      .eq('code_hash', codeHash)
      .maybeSingle();
    if (migrationMissing(result.error)) {
      warnOnce('menu_drafts', '202610190002_menu_ordering.sql');
      return undefined;
    }
    const row = unwrap(result) as {
      id: string;
      company_id: string;
      phone_hash: string | null;
      cart: MenuDraft['cart'] | null;
      quoted_total: number | string;
      expires_at: string;
      used_at: string | null;
      order_id: string | null;
      conversation_id: string | null;
    } | null;
    if (!row) return undefined;
    return {
      id: row.id,
      companyId: row.company_id,
      ...(row.phone_hash && { phoneHash: row.phone_hash }),
      ...(row.cart && { cart: row.cart }),
      quotedTotal: Number(row.quoted_total),
      expiresAt: row.expires_at,
      ...(row.used_at && { usedAt: row.used_at }),
      ...(row.order_id && { orderId: row.order_id }),
      ...(row.conversation_id && { conversationId: row.conversation_id }),
    } satisfies MenuDraft;
  }
}
const orderingMigrationError = () =>
  new PublicError('Apply the menu ordering database migration first.', 503);
// Named arguments shared with the SQL tests, so a renamed parameter fails there too.
export const placeWebOrderArgs = (
  companyId: string,
  conversation: Conversation,
  expectedVersion: number,
  order: Order,
  jobs: Job[],
  claim: WebOrderClaim,
) => ({
  p_company_id: companyId,
  p_conversation: conversation,
  p_expected_version: expectedVersion,
  p_order: order,
  p_jobs: jobs,
  p_claim: claim,
});
// ipKey is always sent: null when the visitor's address is unknown (no per-address cap then).
export const createMenuDraftArgs = (draft: MenuDraftInput, minutes: number, maxOpen: number) => ({
  p_draft: { ...draft, ipKey: draft.ipKey ?? null },
  p_minutes: minutes,
  p_max_open: maxOpen,
});
