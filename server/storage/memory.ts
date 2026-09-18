import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
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
  BotSettings,
  TeamMember,
  Message,
} from '../../src/shared/types';
import {
  seedCompanies,
  seedConversations,
  seedOrders,
  seedProducts,
  seedTraces,
} from '../../src/shared/seed';
import type { Repository } from '../repository';
import { transitionOrder } from '../../src/domain/engine';
import { PublicError } from '../security';
import { orderMatches, pageOf, summaryOf } from '../queries';

interface Reservation {
  funding?: 'own' | 'platform';
  id: string;
  companyId: string;
  amountUsd: number;
  expiresAt: string;
  createdAt?: string;
  settled: boolean;
}
interface State {
  platformLimit: number;
  retention: Record<string, import('../../src/shared/types').RetentionStatus>;
  companies: Company[];
  products: Product[];
  conversations: Conversation[];
  orders: Order[];
  integrations: { companyId: string; integration: Integration; encryptedSecret?: string }[];
  traces: Trace[];
  usage: Usage[];
  jobs: Job[];
  dedupe: Record<string, string>;
  admins: string[];
  memberships: { userId: string; companyId: string; role: Role }[];
  reservations: Reservation[];
  locks: { companyId: string; conversationId: string; ownerId: string; leaseUntil: string }[];
}
const copy = <T>(value: T): T => structuredClone(value);
const freshState = (seed: boolean): State => ({
  platformLimit: 100,
  retention: {},
  companies: seed ? copy(seedCompanies) : [],
  products: seed ? copy(seedProducts) : [],
  conversations: seed ? copy(seedConversations) : [],
  orders: seed ? copy(seedOrders) : [],
  traces: seed ? copy(seedTraces) : [],
  integrations: [],
  usage: [],
  jobs: [],
  dedupe: {},
  admins: seed ? ['demo-admin'] : [],
  memberships: [],
  reservations: [],
  locks: [],
});
const newest = <T>(rows: T[], key: (row: T) => string, limit: number) =>
  rows.sort((a, b) => key(b).localeCompare(key(a))).slice(0, limit);
const companyExists = (state: State, id: string) => {
  if (!state.companies.some((c) => c.id === id)) throw new Error('Unknown company.');
};
const assertOwnership = (existing: { companyId: string } | undefined, companyId: string) => {
  if (existing && existing.companyId !== companyId)
    throw new Error('Cross-company reference is forbidden.');
};
const put = <T extends { id: string }>(rows: T[], value: T) => {
  const index = rows.findIndex((r) => r.id === value.id);
  if (index < 0) rows.push(copy(value));
  else rows[index] = copy(value);
};
const validCost = (amount: number) => {
  if (!Number.isFinite(amount) || amount < 0) throw new Error('Invalid usage amount.');
};

function checkConversation(state: State, conversation: Conversation): void {
  companyExists(state, conversation.companyId);
  assertOwnership(
    state.conversations.find((c) => c.id === conversation.id),
    conversation.companyId,
  );
  if (
    state.conversations.some(
      (c) =>
        c.companyId === conversation.companyId &&
        c.customerPhone === conversation.customerPhone &&
        c.channel === conversation.channel &&
        c.id !== conversation.id,
    )
  )
    throw new Error('Conversation already exists for this channel and phone.');
  for (const item of conversation.cart.items)
    assertOwnership(
      state.products.find((p) => p.id === item.productId),
      conversation.companyId,
    );
  if (conversation.cart.orderId)
    assertOwnership(
      state.orders.find((o) => o.id === conversation.cart.orderId),
      conversation.companyId,
    );
}
function checkOrder(state: State, order: Order, pendingConversation?: Conversation): void {
  companyExists(state, order.companyId);
  assertOwnership(
    state.orders.find((o) => o.id === order.id),
    order.companyId,
  );
  const conversation =
    pendingConversation?.id === order.conversationId
      ? pendingConversation
      : state.conversations.find((c) => c.id === order.conversationId);
  if (!conversation || conversation.companyId !== order.companyId)
    throw new Error('Order conversation belongs to another company or does not exist.');
  for (const item of order.items)
    assertOwnership(
      state.products.find((p) => p.id === item.productId),
      order.companyId,
    );
  if (
    state.orders.some(
      (o) =>
        o.companyId === order.companyId &&
        o.submissionKey === order.submissionKey &&
        o.id !== order.id,
    )
  )
    throw new Error('Duplicate order submission.');
}
function checkJob(state: State, job: Job): void {
  companyExists(state, job.companyId);
  assertOwnership(
    state.jobs.find((j) => j.id === job.id),
    job.companyId,
  );
  if (typeof job.payload.conversationId === 'string') {
    const conversation = state.conversations.find((c) => c.id === job.payload.conversationId);
    if (!conversation || conversation.companyId !== job.companyId)
      throw new Error('Invalid job conversation.');
  }
  if (typeof job.payload.orderId === 'string') {
    const order = state.orders.find((o) => o.id === job.payload.orderId);
    if (!order || order.companyId !== job.companyId) throw new Error('Invalid job order.');
  }
}
function putUsage(state: State, usage: Usage): void {
  companyExists(state, usage.companyId);
  validCost(usage.costUsd);
  const existing = state.usage.find((u) => u.id === usage.id);
  assertOwnership(existing, usage.companyId);
  if (!existing) state.usage.push(copy(usage));
}

// The persisted jobs array is append-only; updating a job keeps its arrival position.
// A failed predecessor remains a barrier until staff retry it successfully.
function incomingHeads(jobs: Job[]): Set<string> {
  const seen = new Set<string>();
  const heads = new Set<string>();
  for (const job of jobs) {
    if (job.kind !== 'incoming' || job.status === 'done') continue;
    const key = JSON.stringify([job.companyId, job.payload.phone]);
    if (!seen.has(key)) {
      seen.add(key);
      heads.add(job.id);
    }
  }
  return heads;
}

/** Development/test store. Every write commits a cloned snapshot, avoiding mutation leaks. */
export class MemoryRepository implements Repository {
  platformBudget() {
    return this.read((s) => {
      const month = new Date().toISOString().slice(0, 7);
      return {
        limitUsd: s.platformLimit,
        spentUsd: s.usage
          .filter((u) => u.funding !== 'own' && u.createdAt.startsWith(month))
          .reduce((n, u) => n + u.costUsd, 0),
        reservedUsd: s.reservations
          .filter(
            (r) =>
              r.funding !== 'own' && !r.settled && (r.createdAt ?? r.expiresAt).startsWith(month),
          )
          .reduce((n, r) => n + r.amountUsd, 0),
      };
    });
  }
  async configurePlatformBudget(limit: number) {
    if (!Number.isFinite(limit) || limit < 0 || limit > 100000)
      throw new PublicError('Invalid platform budget.', 400);
    await this.mutate((s) => {
      s.platformLimit = limit;
    });
    return this.platformBudget();
  }
  async alertPreferences(_companyId: string, _userId: string) {
    return { enabled: false, responseMinutes: 10, emailVerified: false };
  }
  async configureAlerts(
    _companyId: string,
    _userId: string,
    _enabled: boolean,
    _minutes: number,
  ): Promise<import('../../src/shared/types').AlertPreferences> {
    throw new PublicError('Email subscriptions require a hosted verified account.', 409);
  }
  async alertRecipient(_companyId: string, _userId: string): Promise<string | null> {
    return null;
  }
  async hasOverdueAttention(companyId: string, minutes: number) {
    const alerts = await this.staffAttention(companyId);
    return alerts.items.some((a) => Date.parse(a.createdAt) < Date.now() - minutes * 60000);
  }
  staffAttention(companyId: string) {
    return this.read((s) => {
      const items: import('../../src/shared/types').StaffAttention['items'] = [
        ...s.orders
          .filter((o) => o.companyId === companyId && o.sandbox === false && o.status === 'pending')
          .map((o) => ({
            id: `order:${o.id}`,
            kind: 'order' as const,
            entityId: o.id,
            createdAt: o.createdAt,
          })),
        ...s.conversations
          .filter(
            (c) =>
              c.companyId === companyId &&
              c.channel === 'whatsapp' &&
              c.mode === 'human' &&
              c.messages.at(-1)?.role !== 'staff',
          )
          .map((c) => ({
            id: `handoff:${c.id}`,
            kind: 'handoff' as const,
            entityId: c.id,
            createdAt: c.updatedAt,
          })),
        ...s.jobs
          .filter((j) => j.companyId === companyId && j.status === 'failed')
          .map((j) => ({
            id: `job:${j.id}`,
            kind: 'job' as const,
            entityId: j.id,
            createdAt: j.createdAt,
          })),
      ];
      const month = new Date().toISOString().slice(0, 7);
      const budget = s.companies.find((c) => c.id === companyId)?.ai.monthlyBudgetUsd ?? 0;
      const spent =
        s.usage
          .filter((u) => u.companyId === companyId && u.createdAt.startsWith(month))
          .reduce((n, u) => n + u.costUsd, 0) +
        s.reservations
          .filter(
            (r) =>
              r.companyId === companyId &&
              !r.settled &&
              (r.createdAt ?? r.expiresAt).startsWith(month),
          )
          .reduce((n, r) => n + r.amountUsd, 0);
      if (budget > 0 && spent >= budget * 0.8)
        items.push({
          id: `budget:${companyId}:${month}`,
          kind: 'budget',
          entityId: companyId,
          createdAt: month + '-01T00:00:00.000Z',
        });
      return {
        total: items.length,
        orders: items.filter((a) => a.kind === 'order').length,
        handoffs: items.filter((a) => a.kind === 'handoff').length,
        failures: items.filter((a) => a.kind === 'job').length,
        budgets: items.filter((a) => a.kind === 'budget').length,
        items: items
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
          .slice(0, 30),
      };
    });
  }
  retentionStatus(companyId: string, previewDays: number) {
    return this.read((s) => {
      const cutoff = Date.now() - previewDays * 86400000;
      const eligible = s.conversations.filter(
        (c) =>
          c.companyId === companyId &&
          previewDays >= 30 &&
          c.mode === 'bot' &&
          Date.parse(c.updatedAt) < cutoff &&
          Date.parse(c.lastInboundAt ?? c.updatedAt) < cutoff &&
          !s.orders.some(
            (o) =>
              o.companyId === companyId &&
              o.conversationId === c.id &&
              (!['completed', 'rejected', 'cancelled'].includes(o.status) ||
                Date.parse(o.updatedAt) >= cutoff),
          ) &&
          !s.locks.some(
            (l) =>
              l.companyId === companyId &&
              l.conversationId === c.id &&
              Date.parse(l.leaseUntil) > Date.now(),
          ) &&
          !s.jobs.some(
            (j) =>
              j.companyId === companyId &&
              j.status !== 'done' &&
              (j.payload.conversationId === c.id ||
                j.payload.phone === c.customerPhone ||
                s.orders.some(
                  (o) =>
                    o.companyId === companyId &&
                    o.conversationId === c.id &&
                    o.id === j.payload.orderId,
                )),
          ),
      );
      return {
        ...(s.retention[companyId] ?? {
          days: 0,
          eligibleAfter: null,
          lastRunAt: null,
          lastDeleted: 0,
        }),
        eligibleConversations: Math.min(100, eligible.length),
      };
    });
  }
  async configureRetention(companyId: string, days: number, actorId: string) {
    if (!Number.isInteger(days) || !(days === 0 || (days >= 30 && days <= 3650)))
      throw new PublicError('Invalid retention period.', 400);
    await this.mutate((s) => {
      companyExists(s, companyId);
      const old = s.retention[companyId];
      s.retention[companyId] = {
        days,
        eligibleAfter:
          old?.days === days
            ? old.eligibleAfter
            : days
              ? new Date(Date.now() + 86400000).toISOString()
              : null,
        lastRunAt: old?.lastRunAt ?? null,
        lastDeleted: old?.lastDeleted ?? 0,
        eligibleConversations: 0,
      };
    });
    await this.audit(companyId, actorId, `privacy.retention_days.${days}`);
    return this.retentionStatus(companyId, days);
  }
  private receipts = new Map<
    string,
    {
      status: NonNullable<Message['delivery']>;
      conversationId?: string;
      messageId?: string;
      error?: string;
    }
  >();
  async recordDelivery(
    companyId: string,
    externalId: string,
    status: NonNullable<Message['delivery']>,
    conversationId?: string,
    messageId?: string,
    error?: string,
  ) {
    const key = companyId + ':' + externalId;
    const old = this.receipts.get(key);
    const ranks = { accepted: 0, sent: 1, failed: 2, delivered: 3, read: 4 };
    const receipt = {
      status: old && ranks[old.status] > ranks[status] ? old.status : status,
      conversationId: conversationId ?? old?.conversationId,
      messageId: messageId ?? old?.messageId,
      error: error ?? old?.error,
    };
    this.receipts.set(key, receipt);
    if (receipt.conversationId && receipt.messageId)
      await this.mutate((s) => {
        const c = s.conversations.find(
          (c) => c.companyId === companyId && c.id === receipt.conversationId,
        );
        const m = c?.messages.find((m) => m.id === receipt.messageId);
        if (m) {
          m.externalId = externalId;
          m.delivery = receipt.status;
          m.deliveryError = receipt.error;
        }
      });
  }
  async audit(companyId: string, actorId: string, action: string) {
    await this.addTrace({
      id: randomUUID(),
      companyId,
      actorId,
      action,
      detail: 'Administrative change',
      createdAt: new Date().toISOString(),
    });
  }
  private rateLimits = new Map<string, { minute: number; count: number }>();
  listAllowedCompanies(userId: string) {
    return this.read((s) =>
      s.admins.includes(userId)
        ? s.companies
        : s.companies.filter((c) =>
            s.memberships.some((m) => m.companyId === c.id && m.userId === userId),
          ),
    );
  }
  queryOrders(companyId: string, filter: ListFilter) {
    return this.read((s) =>
      pageOf(
        s.orders
          .filter(
            (o) =>
              o.companyId === companyId &&
              orderMatches(o, filter) &&
              (filter.sandbox === undefined ||
                s.conversations.some(
                  (c) => c.id === o.conversationId && (c.channel === 'demo') === filter.sandbox,
                )),
          )
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)),
        filter,
      ),
    );
  }
  queryConversations(companyId: string, filter: ListFilter) {
    return this.read((s) =>
      pageOf(
        s.conversations
          .filter(
            (c) =>
              c.companyId === companyId &&
              (filter.sandbox === undefined || (c.channel === 'demo') === filter.sandbox) &&
              (!filter.status || filter.status === 'all' || c.mode === filter.status) &&
              (!filter.search ||
                `${c.customerName} ${c.customerPhone}`
                  .toLowerCase()
                  .includes(filter.search.toLowerCase())),
          )
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
          .map((c) => ({ ...c, messages: c.messages.slice(-1) })),
        filter,
      ),
    );
  }
  conversationHistory(companyId: string, id: string, page: number) {
    return this.read((s) =>
      pageOf(
        [
          ...(s.conversations.find((c) => c.companyId === companyId && c.id === id)?.messages ??
            []),
        ].reverse(),
        { page, pageSize: 100 },
      ),
    );
  }
  getSummary(companyId: string, sandbox: boolean) {
    return this.read((s) => {
      const conversations = s.conversations.filter(
        (c) => c.companyId === companyId && (c.channel === 'demo') === sandbox,
      );
      return summaryOf(
        s.orders.filter(
          (o) => o.companyId === companyId && conversations.some((c) => c.id === o.conversationId),
        ),
        conversations,
        s.usage.filter((u) => u.companyId === companyId),
      );
    });
  }
  listCompanyJobs(companyId: string) {
    return this.read((s) =>
      s.jobs
        .filter((j) => j.companyId === companyId && j.status !== 'done')
        .slice(-100)
        .reverse(),
    );
  }
  saveBot(companyId: string, settings: BotSettings, expectedRevision: number) {
    return this.mutate((s) => {
      const c = s.companies.find((c) => c.id === companyId);
      if (!c || (c.bot?.revision ?? 0) !== expectedRevision) return false;
      c.bot = copy(settings);
      return true;
    });
  }
  disconnectIntegration(companyId: string, kind: IntegrationKind) {
    return this.mutate((s) => {
      if (
        s.jobs.some(
          (j) =>
            j.companyId === companyId &&
            j.status === 'processing' &&
            Date.parse(j.leaseUntil ?? '') > Date.now(),
        ) ||
        s.locks.some((l) => l.companyId === companyId && Date.parse(l.leaseUntil) > Date.now())
      )
        throw new PublicError('Wait for running jobs to finish before disconnecting.', 409);
      s.integrations = s.integrations.filter(
        (i) => i.companyId !== companyId || i.integration.kind !== kind,
      );
      for (const j of s.jobs.filter(
        (j) =>
          j.companyId === companyId &&
          ((kind === 'sheets' && j.kind === 'sheet_sync') ||
            (kind === 'whatsapp' && ['incoming', 'whatsapp_send'].includes(j.kind))),
      )) {
        j.status = 'done';
        j.payload = {};
      }
      const c = s.companies.find((c) => c.id === companyId);
      if (c) {
        c.botEnabled = false;
        c.modelVerification = undefined;
      }
    });
  }
  recordCall(
    companyId: string,
    orderId: string,
    confirmation: NonNullable<Order['phoneConfirmation']>,
  ) {
    return this.mutate((s) => {
      const o = s.orders.find((o) => o.companyId === companyId && o.id === orderId);
      if (!o || o.status !== 'pending') return undefined;
      o.phoneConfirmation = confirmation;
      o.updatedAt = confirmation.at;
      return o;
    });
  }
  listMembers(companyId: string) {
    return this.read((s) =>
      s.memberships
        .filter((m) => m.companyId === companyId)
        .map((m) => ({ userId: m.userId, role: m.role as 'owner' | 'staff' })),
    );
  }
  setMember(companyId: string, member: TeamMember, actorId: string) {
    return this.mutate((s) => {
      const old = s.memberships.find(
        (m) => m.companyId === companyId && m.userId === member.userId,
      );
      if (
        old?.role === 'owner' &&
        member.role !== 'owner' &&
        (old.userId === actorId ||
          s.memberships.filter((m) => m.companyId === companyId && m.role === 'owner').length <= 1)
      )
        throw new PublicError('Keep another owner and do not demote yourself.', 409);
      if (old) old.role = member.role;
      else s.memberships.push({ companyId, userId: member.userId, role: member.role });
    });
  }
  removeMember(companyId: string, userId: string, actorId: string) {
    return this.mutate((s) => {
      const old = s.memberships.find((m) => m.companyId === companyId && m.userId === userId);
      if (
        userId === actorId ||
        (old?.role === 'owner' &&
          s.memberships.filter((m) => m.companyId === companyId && m.role === 'owner').length <= 1)
      )
        throw new PublicError('Keep another owner and do not remove yourself.', 409);
      s.memberships = s.memberships.filter((m) => m.companyId !== companyId || m.userId !== userId);
    });
  }
  eraseCustomer(companyId: string, phone: string) {
    return this.mutate((s) => {
      if (
        s.companies.find((c) => c.id === companyId)?.botEnabled ||
        s.jobs.some(
          (j) =>
            j.companyId === companyId &&
            j.status === 'processing' &&
            Date.parse(j.leaseUntil ?? '') > Date.now(),
        ) ||
        s.locks.some((l) => l.companyId === companyId && Date.parse(l.leaseUntil) > Date.now())
      )
        throw new PublicError(
          'Pause automation and wait for running work before deleting customer data.',
          409,
        );
      const ids = new Set(
        s.conversations
          .filter((c) => c.companyId === companyId && c.customerPhone === phone)
          .map((c) => c.id),
      );
      const orderIds = new Set(
        s.orders
          .filter((o) => o.companyId === companyId && ids.has(o.conversationId))
          .map((o) => o.id),
      );
      s.jobs = s.jobs.filter(
        (j) =>
          j.companyId !== companyId ||
          !(
            j.payload.phone === phone ||
            ids.has(String(j.payload.conversationId)) ||
            orderIds.has(String(j.payload.orderId))
          ),
      );
      s.traces = s.traces.filter(
        (t) => t.companyId !== companyId || !ids.has(t.conversationId ?? ''),
      );
      s.usage = s.usage.map((u) =>
        u.companyId === companyId && ids.has(u.conversationId ?? '')
          ? { ...u, conversationId: undefined }
          : u,
      );
      s.orders = s.orders.filter((o) => !orderIds.has(o.id));
      s.conversations = s.conversations.filter((c) => !ids.has(c.id));
      return ids.size;
    });
  }
  async consumeRateLimit(key: string, limit: number) {
    const minute = Math.floor(Date.now() / 60000);
    let r = this.rateLimits.get(key);
    if (!r || r.minute !== minute) {
      r = { minute, count: 0 };
      this.rateLimits.set(key, r);
    }
    r.count++;
    if (this.rateLimits.size > 10000)
      for (const [k, v] of this.rateLimits) if (v.minute < minute) this.rateLimits.delete(k);
    return r.count <= limit;
  }
  protected state: State;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(seed = true) {
    this.state = freshState(seed);
  }
  protected async persist(_next: State): Promise<void> {}
  private async read<T>(fn: (state: State) => T): Promise<T> {
    await this.pending;
    return copy(fn(this.state));
  }
  private mutate<T>(fn: (state: State) => T): Promise<T> {
    const operation = this.pending.then(async () => {
      const next = copy(this.state);
      const result = fn(next);
      await this.persist(next);
      this.state = next;
      return copy(result);
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }
  listCompanies() {
    return this.read((s) => s.companies);
  }
  getCompany(id: string) {
    return this.read((s) => s.companies.find((c) => c.id === id));
  }
  saveCompany(company: Company) {
    return this.mutate((s) => {
      if (s.companies.some((c) => c.slug === company.slug && c.id !== company.id))
        throw new Error('Company slug already exists.');
      const previous = s.companies.find((c) => c.id === company.id);
      put(s.companies, previous?.bot ? { ...company, bot: previous.bot } : company);
    });
  }
  isAdmin(userId: string) {
    return this.read((s) => s.admins.includes(userId));
  }
  getRole(userId: string, companyId: string): Promise<Role | null> {
    return this.read((s) =>
      s.admins.includes(userId)
        ? 'admin'
        : (s.memberships.find((m) => m.userId === userId && m.companyId === companyId)?.role ??
          null),
    );
  }
  listProducts(companyId: string) {
    return this.read((s) => s.products.filter((p) => p.companyId === companyId));
  }
  saveProduct(product: Product) {
    return this.mutate((s) => {
      companyExists(s, product.companyId);
      assertOwnership(
        s.products.find((p) => p.id === product.id),
        product.companyId,
      );
      put(s.products, product);
    });
  }
  deleteProduct(companyId: string, id: string) {
    return this.mutate((s) => {
      companyExists(s, companyId);
      s.products = s.products.filter((p) => p.companyId !== companyId || p.id !== id);
    });
  }
  replaceProducts(companyId: string, products: Product[]) {
    return this.mutate((s) => {
      companyExists(s, companyId);
      if (new Set(products.map((p) => p.id)).size !== products.length)
        throw new Error('Duplicate product id.');
      for (const product of products) {
        if (product.companyId !== companyId) throw new Error('Invalid product company.');
        assertOwnership(
          s.products.find((p) => p.id === product.id),
          companyId,
        );
      }
      s.products = [...s.products.filter((p) => p.companyId !== companyId), ...copy(products)];
    });
  }
  listConversations(companyId: string) {
    return this.read((s) =>
      newest(
        s.conversations.filter((c) => c.companyId === companyId),
        (c) => c.updatedAt,
        200,
      ),
    );
  }
  getConversation(companyId: string, id: string) {
    return this.read((s) => s.conversations.find((c) => c.companyId === companyId && c.id === id));
  }
  findConversation(companyId: string, phone: string, channel: Conversation['channel']) {
    return this.read((s) =>
      s.conversations.find(
        (c) => c.companyId === companyId && c.customerPhone === phone && c.channel === channel,
      ),
    );
  }
  saveConversation(conversation: Conversation, expectedVersion?: number) {
    return this.mutate((s) => {
      if (
        s.conversations.some(
          (c) =>
            c.companyId === conversation.companyId &&
            c.customerPhone === conversation.customerPhone &&
            c.channel === conversation.channel &&
            c.id !== conversation.id,
        )
      )
        return false;
      checkConversation(s, conversation);
      const existing = s.conversations.find((c) => c.id === conversation.id);
      if (expectedVersion !== undefined && (existing?.version ?? 0) !== expectedVersion)
        return false;
      if (expectedVersion !== undefined && conversation.version !== expectedVersion + 1)
        throw new Error('Conversation version must advance by one.');
      put(s.conversations, conversation);
      return true;
    });
  }
  acquireConversationLock(
    companyId: string,
    conversationId: string,
    ownerId: string,
    leaseUntil: string,
  ) {
    return this.mutate((s) => {
      companyExists(s, companyId);
      if (
        !ownerId ||
        !Number.isFinite(Date.parse(leaseUntil)) ||
        Date.parse(leaseUntil) <= Date.now()
      )
        throw new Error('Invalid conversation lease.');
      const existing = s.locks.find(
        (l) => l.companyId === companyId && l.conversationId === conversationId,
      );
      if (existing && Date.parse(existing.leaseUntil) > Date.now() && existing.ownerId !== ownerId)
        return false;
      if (existing) {
        existing.ownerId = ownerId;
        existing.leaseUntil = leaseUntil;
      } else s.locks.push({ companyId, conversationId, ownerId, leaseUntil });
      return true;
    });
  }
  releaseConversationLock(companyId: string, conversationId: string, ownerId: string) {
    return this.mutate((s) => {
      s.locks = s.locks.filter(
        (l) =>
          l.companyId !== companyId || l.conversationId !== conversationId || l.ownerId !== ownerId,
      );
    });
  }
  listOrders(companyId: string) {
    return this.read((s) =>
      newest(
        s.orders.filter((o) => o.companyId === companyId),
        (o) => o.createdAt,
        500,
      ),
    );
  }
  getOrder(companyId: string, id: string) {
    return this.read((s) => s.orders.find((o) => o.companyId === companyId && o.id === id));
  }
  saveOrder(order: Order) {
    return this.mutate((s) => {
      checkOrder(s, order);
      put(s.orders, order);
    });
  }
  updateOrderStatus(
    companyId: string,
    id: string,
    expectedStatus: Order['status'],
    newStatus: Order['status'],
    now: string,
    jobs: Job[] = [],
    automatedConversation?: Conversation,
  ) {
    return this.mutate((s) => {
      const order = s.orders.find((o) => o.companyId === companyId && o.id === id);
      if (!order || order.status !== expectedStatus) return undefined;
      if (automatedConversation) {
        const current = s.conversations.find(
          (c) => c.companyId === companyId && c.id === automatedConversation.id,
        );
        if (
          !current ||
          current.mode !== 'bot' ||
          (current.channel === 'whatsapp' &&
            !s.companies.find((c) => c.id === companyId)?.botEnabled) ||
          current.version !== automatedConversation.version - 1
        )
          return undefined;
        if (
          newStatus !== 'cancelled' ||
          expectedStatus !== 'pending' ||
          automatedConversation.companyId !== companyId ||
          current.id !== order.conversationId ||
          current.cart.orderId !== id
        )
          throw new Error('Invalid automatic cancellation.');
        checkConversation(s, automatedConversation);
        put(s.conversations, automatedConversation);
      }
      transitionOrder(order, newStatus, now);
      if (
        newStatus === 'accepted' &&
        order.phoneConfirmationRequired &&
        (order.phoneConfirmation?.outcome !== 'confirmed' ||
          (order.fulfillment === 'delivery' && !order.phoneConfirmation.addressVerified))
      )
        throw new PublicError('Record phone and address confirmation first.', 409);
      order.status = newStatus;
      order.updatedAt = now;
      if (jobs.some((job) => job.kind === 'sheet_sync')) order.syncStatus = 'pending';
      for (const job of jobs) {
        if (job.companyId !== companyId) throw new Error('Cross-company job.');
        checkJob(s, job);
        if (!s.jobs.some((j) => j.id === job.id)) s.jobs.push(copy(job));
      }
      return order;
    });
  }
  setOrderSyncStatus(
    companyId: string,
    id: string,
    status: Order['syncStatus'],
    expectedUpdatedAt?: string,
  ) {
    return this.mutate((s) => {
      const order = s.orders.find((o) => o.companyId === companyId && o.id === id);
      if (order && (!expectedUpdatedAt || order.updatedAt === expectedUpdatedAt))
        order.syncStatus = status;
    });
  }
  retryFailedJobs(companyId: string) {
    return this.mutate((s) => {
      let count = 0;
      for (const job of s.jobs)
        if (job.companyId === companyId && job.status === 'failed') {
          job.status = 'pending';
          job.attempts = 0;
          job.nextRunAt = new Date().toISOString();
          job.leaseUntil = undefined;
          count++;
        }
      return count;
    });
  }
  commitTurn(
    companyId: string,
    conversation: Conversation,
    expectedVersion: number,
    order?: Order,
    jobs: Job[] = [],
    usage?: Usage,
  ) {
    return this.mutate((s) => {
      if (
        conversation.companyId !== companyId ||
        (order && order.companyId !== companyId) ||
        jobs.some((j) => j.companyId !== companyId) ||
        (usage && usage.companyId !== companyId)
      )
        throw new Error('Cross-company turn is forbidden.');
      checkConversation(s, conversation);
      if ((s.conversations.find((c) => c.id === conversation.id)?.version ?? 0) !== expectedVersion)
        return false;
      if (conversation.version !== expectedVersion + 1)
        throw new Error('Conversation version must advance by one.');
      if (
        order &&
        s.orders.some(
          (o) =>
            o.companyId === companyId &&
            o.submissionKey === order.submissionKey &&
            o.id !== order.id,
        )
      )
        return false;
      if (order) {
        if (
          conversation.channel === 'whatsapp' &&
          !s.companies.find((c) => c.id === companyId)?.botEnabled
        )
          return false;
        checkOrder(s, order, conversation);
      }
      put(s.conversations, conversation);
      if (order) put(s.orders, order);
      for (const job of jobs) {
        checkJob(s, job);
        if (!s.jobs.some((j) => j.id === job.id)) s.jobs.push(copy(job));
      }
      if (usage) putUsage(s, usage);
      return true;
    });
  }
  getIntegrations(companyId: string) {
    return this.read((s) =>
      s.integrations.filter((i) => i.companyId === companyId).map((i) => i.integration),
    );
  }
  saveIntegration(companyId: string, integration: Integration, encryptedSecret?: string) {
    return this.mutate((s) => {
      companyExists(s, companyId);
      if (
        integration.kind === 'sheets' &&
        integration.configured &&
        integration.config.spreadsheetId &&
        s.integrations.some(
          (i) =>
            i.companyId !== companyId &&
            i.integration.kind === 'sheets' &&
            i.integration.configured &&
            i.integration.config.spreadsheetId === integration.config.spreadsheetId &&
            (i.integration.config.ordersSheet || 'Orders').toLowerCase() ===
              (integration.config.ordersSheet || 'Orders').toLowerCase(),
        )
      )
        throw new PublicError(
          'That orders spreadsheet tab is already assigned to another company. Choose a different spreadsheet or orders tab.',
          409,
        );
      if (
        integration.kind === 'whatsapp' &&
        integration.config.phoneNumberId &&
        s.integrations.some(
          (i) =>
            i.companyId !== companyId &&
            i.integration.kind === 'whatsapp' &&
            i.integration.config.phoneNumberId === integration.config.phoneNumberId,
        )
      )
        throw new Error('WhatsApp number is already connected to another company.');
      const existing = s.integrations.find(
        (i) => i.companyId === companyId && i.integration.kind === integration.kind,
      );
      if (existing) {
        existing.integration = copy(integration);
        if (encryptedSecret !== undefined) existing.encryptedSecret = encryptedSecret;
      } else s.integrations.push({ companyId, integration: copy(integration), encryptedSecret });
    });
  }
  getSecret(companyId: string, kind: IntegrationKind) {
    return this.read(
      (s) =>
        s.integrations.find((i) => i.companyId === companyId && i.integration.kind === kind)
          ?.encryptedSecret,
    );
  }
  addTrace(trace: Trace) {
    return this.mutate((s) => {
      companyExists(s, trace.companyId);
      assertOwnership(
        s.traces.find((t) => t.id === trace.id),
        trace.companyId,
      );
      if (trace.conversationId) {
        const conversation = s.conversations.find((c) => c.id === trace.conversationId);
        if (!conversation || conversation.companyId !== trace.companyId)
          throw new Error('Invalid trace conversation.');
      }
      put(s.traces, trace);
    });
  }
  listTraces(companyId: string) {
    return this.read((s) =>
      newest(
        s.traces.filter((t) => t.companyId === companyId),
        (t) => t.createdAt,
        200,
      ),
    );
  }
  addUsage(usage: Usage) {
    return this.mutate((s) => putUsage(s, usage));
  }
  listUsage(companyId: string) {
    return this.read((s) => s.usage.filter((u) => u.companyId === companyId));
  }
  reserveBudget(companyId: string, reservationId: string, amountUsd: number, expiresAt: string) {
    return this.mutate((s) => {
      companyExists(s, companyId);
      validCost(amountUsd);
      const now = new Date();
      if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now.getTime())
        throw new Error('Reservation expiry must be in the future.');
      if (
        s.reservations.some((r) => r.id === reservationId) ||
        s.usage.some((u) => u.id === reservationId)
      )
        return false;
      const month = now.toISOString().slice(0, 7);
      const funding = s.companies.find((c) => c.id === companyId)!.ai.keyMode;
      if (funding === 'platform') {
        const platformSpent = s.usage
          .filter((u) => u.funding !== 'own' && u.createdAt.startsWith(month))
          .reduce((n, u) => n + u.costUsd, 0);
        const platformHeld = s.reservations
          .filter(
            (r) =>
              r.funding !== 'own' && !r.settled && (r.createdAt ?? r.expiresAt).startsWith(month),
          )
          .reduce((n, r) => n + r.amountUsd, 0);
        if (platformSpent + platformHeld + amountUsd > s.platformLimit + 1e-9) return false;
      }
      const spent = s.usage
        .filter((u) => u.companyId === companyId && u.createdAt.slice(0, 7) === month)
        .reduce((sum, u) => sum + u.costUsd, 0);
      const reserved = s.reservations
        .filter(
          (r) =>
            r.companyId === companyId &&
            !r.settled &&
            (r.createdAt ?? r.expiresAt).slice(0, 7) === month,
        )
        .reduce((sum, r) => sum + r.amountUsd, 0);
      if (
        spent + reserved + amountUsd >
        s.companies.find((c) => c.id === companyId)!.ai.monthlyBudgetUsd + 1e-9
      )
        return false;
      s.reservations.push({
        funding,
        id: reservationId,
        companyId,
        amountUsd,
        expiresAt,
        createdAt: now.toISOString(),
        settled: false,
      });
      return true;
    });
  }
  settleBudget(reservationId: string, usage: Usage) {
    return this.mutate((s) => {
      const reservation = s.reservations.find((r) => r.id === reservationId);
      if (!reservation || reservation.companyId !== usage.companyId || usage.id !== reservationId)
        throw new Error('Invalid budget settlement.');
      if (reservation.settled) return;
      putUsage(s, { ...usage, funding: reservation.funding ?? 'platform' });
      reservation.settled = true;
    });
  }
  insertJob(job: Job, dedupeKey?: string) {
    return this.mutate((s) => {
      checkJob(s, job);
      if (s.jobs.some((j) => j.id === job.id) || (dedupeKey && Object.hasOwn(s.dedupe, dedupeKey)))
        return false;
      s.jobs.push(copy(job));
      if (dedupeKey)
        Object.defineProperty(s.dedupe, dedupeKey, {
          value: job.id,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      return true;
    });
  }
  getJob(id: string) {
    return this.read((s) => s.jobs.find((j) => j.id === id));
  }
  listDueJobs(limit: number) {
    return this.read((s) => {
      const now = Date.now();
      const heads = incomingHeads(s.jobs);
      return s.jobs
        .filter(
          (j) =>
            (j.kind !== 'incoming' || heads.has(j.id)) &&
            Date.parse(j.nextRunAt) <= now &&
            (j.status === 'pending' ||
              (j.status === 'processing' && (!j.leaseUntil || Date.parse(j.leaseUntil) <= now))),
        )
        .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt))
        .slice(0, Math.min(Math.max(limit, 1), 100));
    });
  }
  claimJob(id: string, now: string, leaseUntil: string) {
    return this.mutate((s) => {
      if (
        !Number.isFinite(Date.parse(now)) ||
        !Number.isFinite(Date.parse(leaseUntil)) ||
        Date.parse(leaseUntil) <= Date.parse(now)
      )
        throw new Error('Invalid job lease.');
      const job = s.jobs.find((j) => j.id === id);
      if (
        !job ||
        (job.kind === 'incoming' && !incomingHeads(s.jobs).has(job.id)) ||
        Date.parse(job.nextRunAt) > Date.parse(now) ||
        (job.status !== 'pending' &&
          !(
            job.status === 'processing' &&
            (!job.leaseUntil || Date.parse(job.leaseUntil) <= Date.parse(now))
          ))
      )
        return undefined;
      job.status = 'processing';
      job.leaseUntil = leaseUntil;
      job.attempts += 1;
      return job;
    });
  }
  saveJob(job: Job) {
    return this.mutate((s) => {
      checkJob(s, job);
      put(s.jobs, job);
    });
  }
  findCompanyByPhoneNumberId(id: string) {
    return this.read((s) => {
      const integration = s.integrations.find(
        (i) => i.integration.kind === 'whatsapp' && i.integration.config.phoneNumberId === id,
      );
      return integration ? s.companies.find((c) => c.id === integration.companyId) : undefined;
    });
  }
}

/** Single-process local demo persistence. Production uses Postgres transactions. */
export class DemoFileRepository extends MemoryRepository {
  private readonly path: string;
  constructor(path = resolve('.local/data.json'), seed = true) {
    super(seed);
    this.path = path;
    if (existsSync(path)) {
      const loaded = JSON.parse(readFileSync(path, 'utf8')) as Partial<State>;
      if (
        !Array.isArray(loaded.companies) ||
        !Array.isArray(loaded.conversations) ||
        !Array.isArray(loaded.orders)
      )
        throw new Error(
          'Demo database is invalid. Restore .local/data.json from backup or move it aside.',
        );
      this.state = { ...freshState(false), ...loaded };
    }
  }
  protected override async persist(next: State): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.path);
  }
}
