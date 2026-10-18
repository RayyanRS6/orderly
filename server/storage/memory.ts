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
  Account,
} from '../../src/shared/types';
import type {
  MenuDraft,
  MenuDraftInput,
  MenuDraftResult,
  MenuLink,
  WebOrderClaim,
  WebOrderOutcome,
} from '../../src/shared/menu';
import {
  seedCompanies,
  seedConversations,
  seedOrders,
  seedProducts,
  seedTraces,
} from '../../src/shared/seed';
import type { PipelineHealth, Repository } from '../repository';
import { transitionOrder } from '../../src/domain/engine';
import { ACCOUNT_IN_USE, LAST_OWNER_MESSAGE, PublicError } from '../security';
import { PLATFORM_AUDIT_ID } from '../config';
import { orderMatches, pageOf, summaryOf } from '../queries';
import { effectiveAiLimits } from '../../src/shared/models';
import {
  GATEWAY_HEARTBEAT_STALE_MS,
  sameAddress,
  type WhatsAppConnection,
  type WhatsAppAddress,
} from '../../src/shared/whatsapp';

interface Reservation {
  id: string;
  companyId: string;
  amountUsd: number;
  expiresAt: string;
  createdAt?: string;
  settled: boolean;
  /** Held for a live customer chat: counts toward the hourly replies while it runs. */
  live?: boolean;
}
interface AiLimitHit {
  companyId: string;
  scope: 'monthly' | 'hourly';
  windowKey: string;
  limitValue: number;
  resetsAt: string;
  firstHitAt: string;
  lastHitAt: string;
}
interface BlockedKey {
  companyId: string;
  key: string;
  blockId: string;
  label: string;
  conversationId?: string;
  blockedBy?: string;
  createdAt: string;
  blockedCount: number;
  lastBlockedAt?: string;
}
type AttentionScope = import('../../src/shared/types').StaffAttention['items'][number]['scope'];
const BLOCK_KEY = /^(pn|lid):[0-9]{5,20}$/;
// Usage that counts as an AI reply toward the spam limits: a live chat's call that cost something.
const countedReply = (u: Usage, companyId: string, since: number) =>
  u.companyId === companyId && u.costUsd > 0 && !u.sandbox && Date.parse(u.createdAt) >= since;
const hourStart = (now: number) => Math.floor(now / 3600000) * 3600000;
// Mirrors SQL ai_replies_this_hour: settled replies plus live calls still running.
const repliesThisHour = (state: State, companyId: string, now: number) => {
  const hour = hourStart(now);
  return (
    state.usage.filter((u) => countedReply(u, companyId, hour)).length +
    state.reservations.filter(
      (r) =>
        r.companyId === companyId &&
        r.live &&
        !r.settled &&
        Date.parse(r.expiresAt) > now &&
        Date.parse(r.createdAt ?? r.expiresAt) >= hour,
    ).length
  );
};
// Mirrors SQL ai_hourly_warning: 80% of this hour's AI replies used, and the hourly limit not
// reached in this hour yet.
const hourlyWarning = (state: State, company: Company | undefined, now: number) =>
  !!company &&
  repliesThisHour(state, company.id, now) >=
    Math.ceil(effectiveAiLimits(company.aiLimits).repliesPerHour * 0.8) &&
  !(state.aiLimitHits ?? []).some(
    (h) =>
      h.companyId === company.id &&
      h.scope === 'hourly' &&
      h.windowKey === new Date(hourStart(now)).toISOString().slice(0, 13),
  );
// Mirrors SQL awaits_staff_reply: automatic notices (marked, or order-status notices saved before
// they were marked) are not a staff reply.
const STATUS_NOTICE =
  /^Order [^ ]+ is now (pending|accepted|preparing|ready|out for delivery|completed|rejected|cancelled)\.$/;
const automaticNotice = (m: Message) =>
  m.notice === true || (m.role === 'staff' && STATUS_NOTICE.test(m.text ?? ''));
const awaitsStaffReply = (messages: Message[]) =>
  messages.filter((m) => !automaticNotice(m)).at(-1)?.role !== 'staff';
// Mirrors SQL waiting_since: a waiting customer has waited since their latest message, unless a
// staff reply (not an automatic notice) came after it. Never later than the chat was saved; with
// no such message, since the chat was saved.
const waitingSince = (c: Conversation) => {
  const last = c.messages
    .filter((m) => !automaticNotice(m) && (m.role === 'customer' || m.role === 'staff'))
    .at(-1);
  return last?.role === 'customer' && Date.parse(last.createdAt) < Date.parse(c.updatedAt)
    ? last.createdAt
    : c.updatedAt;
};
// Mirrors SQL business_time_zone: the business's zone name (or UTC), else Asia/Karachi.
const businessTimeZone = (company?: Company) => {
  const zone = company?.timezone ?? '';
  if (!/^(UTC|GMT|[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z][A-Za-z0-9_+-]*)+)$/.test(zone))
    return 'Asia/Karachi';
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: zone });
    return zone;
  } catch {
    return 'Asia/Karachi';
  }
};
// Mirrors SQL workspace_summary's daily counts: the last 30 of the business's own days, oldest
// first, so an order at 00:30 in Karachi counts on that day.
const dailyOrders = (orders: Order[], timeZone: string, now = Date.now()) => {
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const counts = new Map<string, number>();
  for (const o of orders) {
    const at = Date.parse(o.createdAt);
    if (Number.isNaN(at)) continue;
    const key = day.format(at);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const today = Date.parse(`${day.format(now)}T00:00:00Z`);
  return Array.from({ length: 30 }, (_, i) => {
    const date = new Date(today - (29 - i) * 86400000).toISOString().slice(0, 10);
    return { date, count: counts.get(date) ?? 0 };
  });
};
// Mirrors SQL whatsapp_down: a linked phone that stopped working while its business's bot is on
// (logged out or failed, connected but silent past the heartbeat limit, or still reconnecting
// `minutes` after it went down), with when it stopped. Only a phone that was paired.
const whatsappDown = (state: State, companyId: string, minutes: number, now = Date.now()) => {
  if (!state.companies.find((c) => c.id === companyId)?.botEnabled) return [];
  return (state.whatsappConnections ?? []).flatMap((w): { id: string; downAt: string }[] => {
    if (w.companyId !== companyId || w.provider !== 'baileys' || !w.accountJid) return [];
    const since = (w as WhatsAppConnection & { downSince?: string }).downSince ?? w.updatedAt;
    if (w.status === 'error' || w.status === 'logged_out') return [{ id: w.id, downAt: since }];
    if (w.status === 'connected') {
      const beat = Date.parse(w.lastHeartbeatAt ?? '');
      return Number.isNaN(beat) || beat < now - GATEWAY_HEARTBEAT_STALE_MS
        ? [{ id: w.id, downAt: w.lastHeartbeatAt ?? w.updatedAt }]
        : [];
    }
    return (w.status === 'reconnecting' || w.status === 'connecting') &&
      Date.parse(since) < now - minutes * 60000
      ? [{ id: w.id, downAt: since }]
      : [];
  });
};
// Mirrors SQL erase_customer: only a whole international number is compared by its digits.
const phoneDigits = (value: string) => value.replace(/\D/g, '');
const wholeNumber = (digits: string) => /^[1-9]\d{9,14}$/.test(digits);
// Mirrors SQL erase_customer and customer_records: the exact text in any chat, and on WhatsApp
// every format of a whole number.
const matchesCustomer = (c: Conversation, phone: string) => {
  const digits = phoneDigits(phone);
  return (
    !!phone.trim() &&
    (c.customerPhone === phone ||
      (c.channel === 'whatsapp' && wholeNumber(digits) && phoneDigits(c.customerPhone) === digits))
  );
};
const streamOf = (a: WhatsAppAddress) => `${a.connectionId}:${a.generation}:${a.peer}`;
interface State {
  /** Stands in for Supabase Auth users. */
  accounts?: Account[];
  /** Audit entries filed under PLATFORM_AUDIT_ID, which is not a business. */
  platformAudit?: { actorId: string; action: string; createdAt: string }[];
  menuLinks?: MenuLink[];
  menuLinkUses?: {
    companyId: string;
    nonce: string;
    conversationId: string;
    orderId: string;
    expiresAt: string;
    usedAt: string;
  }[];
  menuDrafts?: (MenuDraft & { codeHash: string; createdAt: string; ipKey?: string })[];
  aiLimitHits?: AiLimitHit[];
  blockedCustomers?: BlockedKey[];
  gatewayNonces?: Record<string, number>;
  whatsappConnections?: WhatsAppConnection[];
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
  const original = state.conversations.find((c) => c.id === conversation.id);
  if (
    original &&
    JSON.stringify(original.whatsappAddress) !== JSON.stringify(conversation.whatsappAddress)
  )
    throw new Error('Cannot change conversation transport');
  assertOwnership(
    state.conversations.find((c) => c.id === conversation.id),
    conversation.companyId,
  );
  if (
    state.conversations.some(
      (c) =>
        c.companyId === conversation.companyId &&
        (conversation.whatsappAddress
          ? sameAddress(c.whatsappAddress, conversation.whatsappAddress)
          : !c.whatsappAddress && c.customerPhone === conversation.customerPhone) &&
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
    const key = JSON.stringify([job.companyId, job.payload.streamKey ?? job.payload.phone]);
    if (!seen.has(key)) {
      seen.add(key);
      heads.add(job.id);
    }
  }
  return heads;
}

/** Development/test store. Every write commits a cloned snapshot, avoiding mutation leaks. */
export class MemoryRepository implements Repository {
  consumeGatewayNonce(nonce: string) {
    return this.mutate((s) => {
      const values = (s.gatewayNonces ??= {});
      for (const [key, expiry] of Object.entries(values))
        if (expiry < Date.now()) delete values[key];
      if (values[nonce]) return false;
      values[nonce] = Date.now() + 120000;
      return true;
    });
  }
  getWhatsAppConnection(companyId: string) {
    return this.read((s) => s.whatsappConnections?.find((c) => c.companyId === companyId));
  }
  findWhatsAppConnection(id: string) {
    return this.read((s) => s.whatsappConnections?.find((c) => c.id === id));
  }
  saveWhatsAppConnection(connection: WhatsAppConnection, expectedRevision: number) {
    return this.mutate((s) => {
      companyExists(s, connection.companyId);
      const rows = (s.whatsappConnections ??= []);
      const current = rows.find((c) => c.companyId === connection.companyId);
      if (
        (current?.revision ?? 0) !== expectedRevision ||
        connection.revision !== expectedRevision + 1
      )
        return false;
      assertOwnership(
        rows.find((c) => c.id === connection.id),
        connection.companyId,
      );
      if (current && (current.id !== connection.id || connection.generation < current.generation))
        throw new Error('Invalid connection transition');
      if (
        connection.accountJid &&
        rows.some(
          (c) =>
            c.companyId !== connection.companyId &&
            c.accountJid === connection.accountJid &&
            !['disconnected', 'logged_out'].includes(c.status),
        )
      )
        throw new PublicError(ACCOUNT_IN_USE, 409);
      put(rows, connection);
      return true;
    });
  }
  findWhatsAppConversation(companyId: string, address: WhatsAppAddress) {
    return this.read((s) =>
      s.conversations.find(
        (c) =>
          c.companyId === companyId &&
          c.channel === 'whatsapp' &&
          sameAddress(c.whatsappAddress, address),
      ),
    );
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
    const recentLimit = await this.read((s) =>
      (s.aiLimitHits ?? []).some(
        (h) => h.companyId === companyId && Date.parse(h.lastHitAt) > Date.now() - 3600000,
      ),
    );
    const phoneDown = await this.read((s) => whatsappDown(s, companyId, minutes).length > 0);
    // Mirrors SQL: an order waiting 15 minutes counts whatever the alert delay, the 80% warning
    // counts at once, and a linked phone that stopped working by its own rule (whatsapp_down).
    return (
      recentLimit ||
      phoneDown ||
      alerts.items.some(
        (a) =>
          a.kind !== 'whatsapp' &&
          ((a.kind === 'limit' && a.id.startsWith('limit:hourly_near:')) ||
            Date.parse(a.createdAt) <
              Date.now() - (a.kind === 'order' ? Math.min(minutes, 15) : minutes) * 60000),
      )
    );
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
              awaitsStaffReply(c.messages) &&
              !c.blocked,
          )
          .map((c) => ({
            id: `handoff:${c.id}`,
            kind: 'handoff' as const,
            entityId: c.id,
            createdAt: waitingSince(c),
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
      const company = s.companies.find((c) => c.id === companyId);
      const budget = company?.ai?.monthlyBudgetUsd ?? 0;
      const limits = (s.aiLimitHits ?? []).filter(
        (h) =>
          h.companyId === companyId &&
          Date.parse(h.resetsAt) > Date.now() &&
          (h.scope === 'monthly'
            ? typeof company?.ai?.monthlyBudgetUsd !== 'number' ||
              h.limitValue >= company.ai.monthlyBudgetUsd
            : h.limitValue >= effectiveAiLimits(company?.aiLimits).repliesPerHour),
      );
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
      if (budget > 0 && spent >= budget * 0.8 && !limits.some((h) => h.scope === 'monthly'))
        items.push({
          id: `budget:${companyId}:${month}`,
          kind: 'budget',
          entityId: companyId,
          createdAt: month + '-01T00:00:00.000Z',
        });
      for (const h of limits)
        items.push({
          id: `limit:${h.scope}:${h.windowKey}`,
          kind: 'limit',
          entityId: companyId,
          createdAt: h.firstHitAt,
          scope: h.scope,
          resetsAt: h.resetsAt,
        });
      const hour = hourStart(Date.now());
      if (hourlyWarning(s, company, Date.now()))
        items.push({
          id: `limit:hourly_near:${new Date(hour).toISOString().slice(0, 13)}`,
          kind: 'limit',
          entityId: companyId,
          createdAt: new Date(hour).toISOString(),
          // Dashboards that do not know this scope show "AI limit reached".
          scope: 'hourly_near' satisfies AttentionScope,
          resetsAt: new Date(hour + 3600000).toISOString(),
        });
      // A reconnecting phone shows after 3 minutes, when Agent flow calls it offline.
      for (const down of whatsappDown(s, companyId, 3))
        items.push({
          id: `whatsapp:${down.id}`,
          kind: 'whatsapp',
          entityId: down.id,
          createdAt: down.downAt,
        });
      return {
        total: items.length,
        orders: items.filter((a) => a.kind === 'order').length,
        handoffs: items.filter((a) => a.kind === 'handoff').length,
        failures: items.filter((a) => a.kind === 'job').length,
        budgets: items.filter((a) => a.kind === 'budget').length,
        // Limits reached; the 80% warning is not one.
        limits: items.filter((a) => a.kind === 'limit' && !a.id.startsWith('limit:hourly_near:'))
          .length,
        whatsapp: items.filter((a) => a.kind === 'whatsapp').length,
        items: items
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
          .slice(0, 30),
      };
    });
  }
  // Mirrors SQL orderly_pipeline_health. This store processes its own jobs, so its scheduler is
  // always set up; there is no recovery history or worker log to read.
  pipelineHealth() {
    return this.read((s): PipelineHealth => {
      const cutoff = Date.now() - 3 * 60000;
      // Behind a customer's failed message: already shown as a failed job.
      const held = (j: Job) =>
        j.kind === 'incoming' &&
        s.jobs
          .slice(0, s.jobs.indexOf(j))
          .some(
            (e) =>
              e.kind === 'incoming' &&
              e.status === 'failed' &&
              e.companyId === j.companyId &&
              (e.payload.streamKey ?? e.payload.phone) === (j.payload.streamKey ?? j.payload.phone),
          );
      const stalled = s.jobs.filter(
        (j) =>
          j.attempts < 5 &&
          ((j.status === 'pending' && Date.parse(j.nextRunAt) < cutoff) ||
            (j.status === 'processing' && Date.parse(j.leaseUntil ?? j.nextRunAt) < cutoff)) &&
          !held(j),
      );
      const oldest = stalled.map((j) => j.nextRunAt).sort()[0];
      return {
        status: stalled.length ? 'stalled' : 'ok',
        stalledJobs: stalled.length,
        oldestDueAt: oldest ? new Date(oldest).toISOString() : null,
        schedulerConfigured: true,
        recoveryScheduled: true,
        lastRecoverRun: null,
        recentWorkerErrors: null,
        dbSizeBytes: new TextEncoder().encode(JSON.stringify(s)).length,
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
          if (!externalId.startsWith('job:')) m.externalId = externalId;
          m.delivery = receipt.status;
          m.deliveryError = receipt.error;
        }
      });
  }
  async audit(companyId: string, actorId: string, action: string) {
    if (companyId === PLATFORM_AUDIT_ID)
      return this.mutate((s) => {
        (s.platformAudit ??= []).push({ actorId, action, createdAt: new Date().toISOString() });
      });
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
      const orders = s.orders.filter(
        (o) => o.companyId === companyId && conversations.some((c) => c.id === o.conversationId),
      );
      return {
        ...summaryOf(
          orders,
          conversations,
          s.usage.filter((u) => u.companyId === companyId),
        ),
        daily: dailyOrders(orders, businessTimeZone(s.companies.find((c) => c.id === companyId))),
      };
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
            (kind === 'whatsapp' &&
              ['incoming', 'whatsapp_send', 'order_followup'].includes(j.kind))),
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
      const owners = s.memberships.filter(
        (m) => m.companyId === companyId && m.role === 'owner',
      ).length;
      // Mirrors SQL manage_member: nobody gives themselves a non-owner role, and the last
      // owner stays an owner.
      if (
        member.role !== 'owner' &&
        (member.userId === actorId || (old?.role === 'owner' && owners <= 1))
      )
        throw new PublicError(LAST_OWNER_MESSAGE, 409);
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
        throw new PublicError(LAST_OWNER_MESSAGE, 409);
      s.memberships = s.memberships.filter((m) => m.companyId !== companyId || m.userId !== userId);
    });
  }
  listAccounts() {
    return this.read((s) =>
      [...(s.accounts ?? [])].sort(
        (a, b) => (a.email ?? '').localeCompare(b.email ?? '') || a.userId.localeCompare(b.userId),
      ),
    );
  }
  getAccounts(userIds: string[]) {
    return this.read((s) => (s.accounts ?? []).filter((a) => userIds.includes(a.userId)));
  }
  findAccountByEmail(email: string) {
    const wanted = email.trim().toLowerCase();
    return this.read((s) => s.accounts?.find((a) => a.email?.toLowerCase() === wanted));
  }
  // Like Supabase, the account exists from the moment it is invited.
  inviteAccount(email: string) {
    return this.mutate((s) => {
      const account: Account = {
        userId: randomUUID(),
        email: email.trim().toLowerCase(),
        createdAt: new Date().toISOString(),
        invited: true,
      };
      (s.accounts ??= []).push(account);
      return account.userId;
    });
  }
  // Mirrors the auth.users cascade: memberships and the admin row go with the account.
  deleteAccount(userId: string) {
    return this.mutate((s) => {
      if (!s.accounts?.some((a) => a.userId === userId))
        throw new PublicError('This account no longer exists.', 404);
      s.accounts = s.accounts.filter((a) => a.userId !== userId);
      s.memberships = s.memberships.filter((m) => m.userId !== userId);
      s.admins = s.admins.filter((id) => id !== userId);
    });
  }
  listAllMemberships() {
    return this.read((s) =>
      s.memberships.map((m) => ({
        companyId: m.companyId,
        userId: m.userId,
        role: m.role as 'owner' | 'staff',
      })),
    );
  }
  listAdminIds() {
    return this.read((s) => [...s.admins]);
  }
  /** Test helper: an Auth account. */
  addAccount(account: Account) {
    return this.mutate((s) => {
      (s.accounts ??= []).push(account);
    });
  }
  /** Test helper: a platform admin. */
  grantAdmin(userId: string) {
    return this.mutate((s) => {
      s.admins.push(userId);
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
      if (!phone.trim()) throw new Error('Customer phone number required');
      // Mirrors SQL erase_customer: every format of a whole number, and the chats' own jobs.
      const digits = phoneDigits(phone);
      const samePhone = (value: unknown, whatsapp: boolean) =>
        typeof value === 'string' &&
        (value === phone || (whatsapp && wholeNumber(digits) && phoneDigits(value) === digits));
      const erased = s.conversations.filter(
        (c) => c.companyId === companyId && samePhone(c.customerPhone, c.channel === 'whatsapp'),
      );
      const ids = new Set(erased.map((c) => c.id));
      const orderIds = new Set(
        s.orders
          .filter((o) => o.companyId === companyId && ids.has(o.conversationId))
          .map((o) => o.id),
      );
      const addresses = erased.flatMap((c) => (c.whatsappAddress ? [c.whatsappAddress] : []));
      const streams = new Set(addresses.map(streamOf));
      const blockIds = new Set(erased.flatMap((c) => (c.blocked ? [c.blocked.blockId] : [])));
      for (const b of s.blockedCustomers ?? [])
        if (
          b.companyId === companyId &&
          ((b.conversationId && ids.has(b.conversationId)) ||
            (wholeNumber(digits) && b.key === `pn:${digits}`))
        )
          blockIds.add(b.blockId);
      s.jobs = s.jobs.filter(
        (j) =>
          j.companyId !== companyId ||
          !(
            samePhone(j.payload.phone, true) ||
            ids.has(String(j.payload.conversationId)) ||
            orderIds.has(String(j.payload.orderId)) ||
            streams.has(String(j.payload.streamKey)) ||
            addresses.some((a) => sameAddress(a, j.payload.whatsappAddress as WhatsAppAddress))
          ),
      );
      // The block still applies (its keys stay) but no longer names the customer or their chat.
      for (const b of s.blockedCustomers ?? [])
        if (b.companyId === companyId && blockIds.has(b.blockId)) {
          b.label = 'Erased customer';
          delete b.conversationId;
        }
      for (const [key, receipt] of this.receipts)
        if (key.startsWith(`${companyId}:`) && !receipt.conversationId) this.receipts.delete(key);
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
  // Mirrors SQL customer_records.
  customerRecords(companyId: string, phone: string) {
    return this.read((s) => {
      const conversations = s.conversations
        .filter((c) => c.companyId === companyId && matchesCustomer(c, phone))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
        .slice(0, 200);
      const ids = new Set(conversations.map((c) => c.id));
      const orders = s.orders
        .filter((o) => o.companyId === companyId && ids.has(o.conversationId))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
      return { conversations, orders };
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
  markCatalogSynced(companyId: string, syncedAt: string) {
    return this.mutate((s) => {
      const company = s.companies.find((c) => c.id === companyId);
      if (
        company &&
        (!company.catalogSyncedAt || Date.parse(company.catalogSyncedAt) < Date.parse(syncedAt))
      )
        company.catalogSyncedAt = new Date(syncedAt).toISOString();
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
            (conversation.whatsappAddress
              ? sameAddress(c.whatsappAddress, conversation.whatsappAddress)
              : !c.whatsappAddress && c.customerPhone === conversation.customerPhone) &&
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
  // Mirrors SQL reserve_ai_call.
  reserveAiCall(
    companyId: string,
    reservationId: string,
    amountUsd: number,
    expiresAt: string,
    conversationId?: string,
    customerSince?: string,
  ) {
    return this.mutate((s): import('../../src/shared/types').AiCallReservation => {
      companyExists(s, companyId);
      validCost(amountUsd);
      const now = new Date();
      if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now.getTime())
        throw new Error('Reservation expiry must be in the future.');
      if (
        s.reservations.some((r) => r.id === reservationId) ||
        s.usage.some((u) => u.id === reservationId)
      )
        return { ok: false, limit: 'duplicate' };
      const company = s.companies.find((c) => c.id === companyId)!;
      const month = now.toISOString().slice(0, 7);
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
      const hit = (
        scope: AiLimitHit['scope'],
        windowKey: string,
        limitValue: number,
        resetsAt: string,
      ) => {
        const hits = (s.aiLimitHits ??= []).filter(
          (h) =>
            h.companyId !== companyId || Date.parse(h.resetsAt) >= now.getTime() - 40 * 86400000,
        );
        const current = hits.find(
          (h) => h.companyId === companyId && h.scope === scope && h.windowKey === windowKey,
        );
        if (current) {
          current.limitValue = limitValue;
          current.lastHitAt = now.toISOString();
          if (resetsAt > current.resetsAt) current.resetsAt = resetsAt;
        } else
          hits.push({
            companyId,
            scope,
            windowKey,
            limitValue,
            resetsAt,
            firstHitAt: now.toISOString(),
            lastHitAt: now.toISOString(),
          });
        s.aiLimitHits = hits;
      };
      if (spent + reserved + amountUsd > company.ai.monthlyBudgetUsd + 1e-9) {
        const resetAt = new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
        ).toISOString();
        hit('monthly', month, company.ai.monthlyBudgetUsd, resetAt);
        return {
          ok: false,
          limit: 'monthly',
          limitValue: company.ai.monthlyBudgetUsd,
          resetAt,
        };
      }
      if (conversationId) {
        const limits = effectiveAiLimits(company.aiLimits);
        const hour = hourStart(now.getTime());
        if (repliesThisHour(s, companyId, now.getTime()) >= limits.repliesPerHour) {
          const resetAt = new Date(hour + 3600000).toISOString();
          hit('hourly', new Date(hour).toISOString().slice(0, 13), limits.repliesPerHour, resetAt);
          return { ok: false, limit: 'hourly', limitValue: limits.repliesPerHour, resetAt };
        }
        const since = Math.max(
          now.getTime() - 3600000,
          Math.min(customerSince ? Date.parse(customerSince) : -Infinity, now.getTime()),
        );
        if (
          s.usage.filter(
            (u) => countedReply(u, companyId, since) && u.conversationId === conversationId,
          ).length >= limits.repliesPerCustomerPerHour
        )
          return {
            ok: false,
            limit: 'customer',
            limitValue: limits.repliesPerCustomerPerHour,
            resetAt: new Date(now.getTime() + 3600000).toISOString(),
          };
      }
      s.reservations.push({
        id: reservationId,
        companyId,
        amountUsd,
        expiresAt,
        createdAt: now.toISOString(),
        settled: false,
        live: !!conversationId,
      });
      return { ok: true };
    });
  }
  aiLimitStatus(companyId: string) {
    return this.read((s) => {
      companyExists(s, companyId);
      const limits = effectiveAiLimits(s.companies.find((c) => c.id === companyId)!.aiLimits);
      const hour = hourStart(Date.now());
      return {
        repliesThisHour: repliesThisHour(s, companyId, Date.now()),
        ...limits,
        hourResetsAt: new Date(hour + 3600000).toISOString(),
      };
    });
  }
  // Mirrors SQL block_customer.
  blockCustomer(
    companyId: string,
    conversationId: string,
    blockId: string,
    keys: string[],
    label: string,
    actorId: string,
  ) {
    return this.mutate((s) => {
      if (!blockId || !keys.length) throw new Error('Nothing to block');
      if (keys.some((k) => !BLOCK_KEY.test(k))) throw new Error('Invalid block key');
      const conversation = s.conversations.find(
        (c) => c.companyId === companyId && c.id === conversationId,
      );
      if (!conversation) throw new Error('Unknown conversation');
      if (conversation.channel !== 'whatsapp')
        throw new Error('Only WhatsApp chats can be blocked');
      if (conversation.blocked) return conversation;
      const rows = (s.blockedCustomers ??= []);
      const now = new Date().toISOString();
      // One person, one block: join and merge the blocks that already hold these keys.
      const holding = rows
        .filter((r) => r.companyId === companyId && keys.includes(r.key))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.key.localeCompare(b.key));
      const target = holding[0]?.blockId ?? blockId;
      const merged = new Set(holding.map((r) => r.blockId));
      for (const r of rows)
        if (r.companyId === companyId && merged.has(r.blockId)) r.blockId = target;
      for (const c of s.conversations)
        if (
          c.companyId === companyId &&
          c.blocked &&
          merged.has(c.blocked.blockId) &&
          c.blocked.blockId !== target
        ) {
          c.blocked = { ...c.blocked, blockId: target };
          c.version += 1;
          c.updatedAt = now;
        }
      for (const key of new Set(keys))
        if (!rows.some((r) => r.companyId === companyId && r.key === key))
          rows.push({
            companyId,
            key,
            blockId: target,
            label: label.slice(0, 200),
            conversationId,
            blockedBy: actorId,
            createdAt: now,
            blockedCount: 0,
          });
      delete conversation.botPausedAt;
      delete conversation.limitPause;
      conversation.blocked = { at: now, blockId: target };
      conversation.mode = 'bot';
      conversation.version += 1;
      conversation.updatedAt = now;
      return conversation;
    });
  }
  unblockCustomer(companyId: string, blockId: string) {
    return this.mutate((s) => {
      const rows = s.blockedCustomers ?? [];
      const kept = rows.filter((r) => !(r.companyId === companyId && r.blockId === blockId));
      const removed = rows.length - kept.length;
      s.blockedCustomers = kept;
      let cleared = 0;
      const now = new Date().toISOString();
      for (const c of s.conversations)
        if (
          c.companyId === companyId &&
          c.blocked &&
          !kept.some((r) => r.companyId === companyId && r.blockId === c.blocked!.blockId)
        ) {
          delete c.blocked;
          c.version += 1;
          c.updatedAt = now;
          cleared += 1;
        }
      return removed > 0 || cleared > 0;
    });
  }
  findBlockedCustomer(companyId: string, keys: string[]) {
    return this.mutate((s) => {
      const rows = (s.blockedCustomers ??= []);
      const matched = rows
        .filter((r) => r.companyId === companyId && keys.includes(r.key))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.key.localeCompare(b.key))[0];
      if (!matched) return undefined;
      matched.blockedCount += 1;
      matched.lastBlockedAt = new Date().toISOString();
      for (const key of new Set(keys))
        if (BLOCK_KEY.test(key) && !rows.some((r) => r.companyId === companyId && r.key === key))
          rows.push({ ...matched, key, blockedCount: 0, lastBlockedAt: undefined });
      return matched.blockId;
    });
  }
  listBlockedCustomers(companyId: string) {
    return this.read((s) => {
      const blocks = new Map<string, import('../../src/shared/types').BlockedCustomer>();
      for (const r of (s.blockedCustomers ?? []).filter((row) => row.companyId === companyId)) {
        const block = blocks.get(r.blockId);
        if (!block)
          blocks.set(r.blockId, {
            blockId: r.blockId,
            label: r.label,
            keys: [r.key],
            conversationId: r.conversationId,
            blockedBy: r.blockedBy,
            createdAt: r.createdAt,
            blockedCount: r.blockedCount,
            lastBlockedAt: r.lastBlockedAt,
          });
        else {
          block.keys.push(r.key);
          block.blockedCount += r.blockedCount;
          if (r.createdAt < block.createdAt) block.createdAt = r.createdAt;
          if (r.lastBlockedAt && (!block.lastBlockedAt || r.lastBlockedAt > block.lastBlockedAt))
            block.lastBlockedAt = r.lastBlockedAt;
        }
      }
      return [...blocks.values()]
        .map((b) => ({ ...b, keys: b.keys.sort() }))
        .sort(
          (a, b) => b.createdAt.localeCompare(a.createdAt) || a.blockId.localeCompare(b.blockId),
        );
    });
  }
  settleBudget(reservationId: string, usage: Usage) {
    return this.mutate((s) => {
      const reservation = s.reservations.find((r) => r.id === reservationId);
      if (!reservation || reservation.companyId !== usage.companyId || usage.id !== reservationId)
        throw new Error('Invalid budget settlement.');
      if (reservation.settled) return;
      putUsage(s, usage);
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
  hasEarlierSend(companyId: string, conversationId: string, job: Job, activeLeaseAfter: string) {
    return this.read((s) =>
      s.jobs.some(
        (j) =>
          j.companyId === companyId &&
          j.id !== job.id &&
          j.kind === 'whatsapp_send' &&
          (j.status === 'pending' ||
            (j.status === 'processing' && (j.leaseUntil ?? '') > activeLeaseAfter)) &&
          j.payload.conversationId === conversationId &&
          j.createdAt < job.createdAt,
      ),
    );
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
  getMenuLink(companyId: string) {
    return this.read((s) => s.menuLinks?.find((l) => l.companyId === companyId));
  }
  findMenuLink(slug: string) {
    return this.read((s) => s.menuLinks?.find((l) => l.slug === slug));
  }
  // Mirrors SQL set_menu_link.
  setMenuLink(companyId: string, enabled: boolean, slug: string) {
    return this.mutate((s) => {
      companyExists(s, companyId);
      const rows = (s.menuLinks ??= []);
      const updatedAt = new Date().toISOString();
      const existing = rows.find((l) => l.companyId === companyId);
      if (existing) {
        existing.enabled = enabled;
        existing.updatedAt = updatedAt;
        return existing;
      }
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) || slug.length < 3 || slug.length > 72)
        throw new Error('Invalid menu link');
      let chosen = slug;
      for (let attempt = 2; rows.some((l) => l.slug === chosen); attempt++) {
        if (attempt > 50) throw new Error('Could not choose a free menu link');
        chosen = `${slug}-${attempt}`;
      }
      const link: MenuLink = { companyId, slug: chosen, enabled, updatedAt };
      rows.push(link);
      return link;
    });
  }
  // Mirrors SQL place_web_order.
  placeWebOrder(
    companyId: string,
    conversation: Conversation,
    expectedVersion: number,
    order: Order,
    jobs: Job[],
    claim: WebOrderClaim,
  ) {
    return this.mutate((s): WebOrderOutcome => {
      if (
        conversation.companyId !== companyId ||
        order.companyId !== companyId ||
        order.conversationId !== conversation.id
      )
        throw new Error('Cross-company web order');
      if (
        conversation.channel !== 'whatsapp' ||
        order.sandbox !== false ||
        order.status !== 'pending' ||
        order.source !== 'menu_page' ||
        conversation.cart.status !== 'submitted' ||
        conversation.cart.orderId !== order.id ||
        !Array.isArray(claim.keys)
      )
        throw new Error('Invalid web order');
      const company = s.companies.find((c) => c.id === companyId);
      if (!company) throw new Error('Unknown company');
      const existing = s.orders.find(
        (o) => o.companyId === companyId && o.submissionKey === order.submissionKey,
      );
      if (existing) return { ok: false, reason: 'duplicate', order: existing };
      if (!company.botEnabled) return { ok: false, reason: 'bot_off' };
      if (
        (s.blockedCustomers ?? []).some(
          (b) => b.companyId === companyId && claim.keys.includes(b.key),
        )
      )
        return { ok: false, reason: 'blocked' };
      const now = new Date().toISOString();
      let draft: NonNullable<State['menuDrafts']>[number] | undefined;
      if (claim.kind === 'link') {
        if (!/^[A-Za-z0-9_-]{11}$/.test(claim.nonce ?? '') || !claim.expiresAt)
          throw new Error('Invalid menu link claim');
        if (
          (s.menuLinkUses ?? []).some((u) => u.companyId === companyId && u.nonce === claim.nonce)
        )
          return { ok: false, reason: 'used' };
        if (Date.parse(claim.expiresAt) <= Date.now()) return { ok: false, reason: 'expired' };
      } else if (claim.kind === 'draft') {
        draft = s.menuDrafts?.find((d) => d.id === claim.draftId && d.companyId === companyId);
        if (!draft) return { ok: false, reason: 'expired' };
        if (draft.usedAt) return { ok: false, reason: 'used' };
        if (Date.parse(draft.expiresAt) <= Date.now()) return { ok: false, reason: 'expired' };
      } else throw new Error('Invalid web order claim');
      const current = s.conversations.find(
        (c) => c.id === conversation.id && c.companyId === companyId,
      );
      if (current) {
        if (current.version !== expectedVersion)
          return { ok: false, reason: 'conversation_changed' };
        if (current.blocked) return { ok: false, reason: 'blocked' };
        if (current.mode !== 'bot') return { ok: false, reason: 'staff' };
        if (claim.kind === 'link' && conversation.lastInboundAt !== current.lastInboundAt)
          throw new Error('A menu link order must not change lastInboundAt');
      } else if (claim.kind === 'link' || expectedVersion !== 0)
        return { ok: false, reason: 'conversation_changed' };
      if (conversation.version !== expectedVersion + 1)
        throw new Error('Conversation version must advance by one.');
      if (
        s.conversations.some(
          (c) =>
            c.companyId === companyId &&
            c.channel === conversation.channel &&
            c.id !== conversation.id &&
            (conversation.whatsappAddress
              ? sameAddress(c.whatsappAddress, conversation.whatsappAddress)
              : !c.whatsappAddress && c.customerPhone === conversation.customerPhone),
        )
      )
        throw new Error('Conversation changed during web order');
      checkConversation(s, conversation);
      checkOrder(s, order, conversation);
      put(s.conversations, conversation);
      put(s.orders, order);
      if (claim.kind === 'link')
        (s.menuLinkUses ??= []).push({
          companyId,
          nonce: claim.nonce,
          conversationId: conversation.id,
          orderId: order.id,
          expiresAt: claim.expiresAt,
          usedAt: now,
        });
      else if (draft) {
        draft.usedAt = now;
        draft.orderId = order.id;
        draft.conversationId = conversation.id;
        delete draft.cart;
        delete draft.phoneHash;
        delete draft.ipKey;
      }
      for (const job of jobs) {
        if (job.companyId !== companyId) throw new Error('Cross-company job');
        checkJob(s, job);
        if (!s.jobs.some((j) => j.id === job.id)) s.jobs.push(copy(job));
      }
      return { ok: true, order };
    });
  }
  findMenuLinkUse(companyId: string, nonce: string) {
    return this.read((s) => {
      const use = s.menuLinkUses?.find((u) => u.companyId === companyId && u.nonce === nonce);
      return use && { orderId: use.orderId, conversationId: use.conversationId };
    });
  }
  hasBlockedKey(companyId: string, keys: string[]) {
    return this.read((s) =>
      (s.blockedCustomers ?? []).some((b) => b.companyId === companyId && keys.includes(b.key)),
    );
  }
  // Mirrors SQL create_menu_draft, including its 15 open drafts per network address.
  createMenuDraft(draft: MenuDraftInput, minutes = 30, maxOpen = 2000) {
    return this.mutate((s): MenuDraftResult => {
      if (!Number.isInteger(minutes) || minutes < 5 || minutes > 60 || maxOpen < 1)
        throw new Error('Invalid menu draft limits');
      if (
        !draft.id ||
        !draft.cart ||
        typeof draft.quotedTotal !== 'number' ||
        !/^[0-9a-f]{64}$/.test(draft.codeHash) ||
        !/^[0-9a-f]{64}$/.test(draft.phoneHash) ||
        (draft.ipKey != null && !/^[A-Za-z0-9_-]{22}$/.test(draft.ipKey))
      )
        throw new Error('Invalid menu draft');
      companyExists(s, draft.companyId);
      const rows = (s.menuDrafts ??= []);
      const open = rows.filter(
        (d) => d.companyId === draft.companyId && !d.usedAt && Date.parse(d.expiresAt) > Date.now(),
      );
      if (open.length >= maxOpen) return { ok: false, reason: 'busy' };
      if (draft.ipKey && open.filter((d) => d.ipKey === draft.ipKey).length >= 15)
        return { ok: false, reason: 'busy_source' };
      if (rows.some((d) => d.codeHash === draft.codeHash || d.id === draft.id))
        return { ok: false, reason: 'collision' };
      const now = Date.now();
      const createdAt = new Date(now).toISOString();
      const expiresAt = new Date(now + minutes * 60000).toISOString();
      const { ipKey, ...fields } = copy(draft);
      rows.push({ ...fields, ...(ipKey && { ipKey }), createdAt, expiresAt });
      // The number's older open drafts end now and are wiped as on expiry.
      for (const old of open.filter((d) => d.phoneHash === draft.phoneHash)) {
        old.expiresAt = new Date(Math.max(now, Date.parse(old.createdAt) + 1)).toISOString();
        delete old.cart;
        delete old.phoneHash;
        delete old.ipKey;
      }
      return { ok: true, expiresAt };
    });
  }
  findMenuDraft(companyId: string, codeHash: string) {
    return this.read((s) => {
      const draft = s.menuDrafts?.find((d) => d.companyId === companyId && d.codeHash === codeHash);
      if (!draft) return undefined;
      const { codeHash: _code, createdAt: _created, ipKey: _ip, ...rest } = draft;
      return rest as MenuDraft;
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
    } else if (seed) {
      // Sample people for the People page and Team access. Tests that use
      // new MemoryRepository() start without any.
      const company = seedCompanies[0].id;
      const signedIn = '2026-10-15T09:30:00.000Z';
      const people = {
        owner: '00000000-0000-4000-8000-000000000101',
        staff: '00000000-0000-4000-8000-000000000102',
        invited: '00000000-0000-4000-8000-000000000103',
      };
      this.state.accounts = [
        {
          userId: people.owner,
          email: 'owner@example.com',
          createdAt: '2026-09-01T08:00:00.000Z',
          lastSignInAt: signedIn,
        },
        {
          userId: people.staff,
          email: 'staff@example.com',
          createdAt: '2026-09-02T08:00:00.000Z',
          lastSignInAt: signedIn,
        },
        {
          userId: people.invited,
          email: 'new@example.com',
          createdAt: '2026-10-10T08:00:00.000Z',
          invited: true,
        },
      ];
      this.state.memberships.push(
        { companyId: company, userId: people.owner, role: 'owner' },
        { companyId: company, userId: people.staff, role: 'staff' },
      );
    }
  }
  protected override async persist(next: State): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.path);
  }
}
