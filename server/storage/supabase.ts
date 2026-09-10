import { createClient, type SupabaseClient } from '@supabase/supabase-js';
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
} from '../../src/shared/types';
import type { Repository } from '../repository';
import { PublicError } from '../security';

type Result<T> = { data: T | null; error: { message: string } | null };
function unwrap<T>(result: Result<T>): T | null {
  if (result.error) throw new Error(`Database operation failed: ${result.error.message}`);
  return result.data;
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

/** All methods run on the server using the service role; API authorization is required. */
export class SupabaseRepository implements Repository {
  private client: SupabaseClient;
  constructor(url: string, serviceRoleKey: string) {
    this.client = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
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
  listCompanies() {
    return this.list<Company>('companies');
  }
  getCompany(id: string) {
    return this.get<Company>('companies', id);
  }
  async saveCompany(company: Company) {
    unwrap(
      await this.client.from('companies').upsert({
        id: company.id,
        slug: company.slug,
        data: company,
        created_at: company.createdAt,
      }),
    );
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
  getConversation(companyId: string, id: string) {
    return this.get<Conversation>('conversations', id, companyId);
  }
  async findConversation(companyId: string, phone: string, channel: Conversation['channel']) {
    const row = unwrap(
      await this.client
        .from('conversations')
        .select('data')
        .eq('company_id', companyId)
        .eq('customer_phone', phone)
        .eq('channel', channel)
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
  listTraces(companyId: string) {
    return this.list<Trace>('traces', companyId, 'created_at', 200);
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
  reserveBudget(companyId: string, reservationId: string, amountUsd: number, expiresAt: string) {
    return this.rpc<boolean>('reserve_budget', {
      p_company_id: companyId,
      p_reservation_id: reservationId,
      p_amount_usd: amountUsd,
      p_expires_at: expiresAt,
    });
  }
  async settleBudget(reservationId: string, usage: Usage) {
    await this.rpc('settle_budget', { p_reservation_id: reservationId, p_usage: usage });
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
}
