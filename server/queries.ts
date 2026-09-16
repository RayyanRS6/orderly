import type { Conversation, ListFilter, Order, PageResult, Usage, WorkspaceSummary } from '../src/shared/types';
export function pageOf<T>(items: T[], filter: ListFilter): PageResult<T> {
  const page = Math.max(1, filter.page ?? 1), pageSize = Math.min(100, Math.max(1, filter.pageSize ?? 50));
  return { items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize };
}
export function orderMatches(o: Order, f: ListFilter) {
  return (!f.search || `${o.reference} ${o.customerName} ${o.customerPhone}`.toLowerCase().includes(f.search.toLowerCase())) &&
    (!f.status || f.status === 'all' || (f.status === 'active' ? ['accepted','preparing','ready','out_for_delivery'].includes(o.status) : o.status === f.status)) &&
    (!f.from || o.createdAt >= f.from) && (!f.to || o.createdAt <= f.to);
}
export function summaryOf(orders: Order[], conversations: Conversation[], usage: Usage[]): WorkspaceSummary {
  const since = new Date().toISOString().slice(0,7);
  return { orders: orders.length, pending: orders.filter(o=>o.status==='pending').length, value: orders.filter(o=>!['cancelled','rejected'].includes(o.status)).reduce((a,o)=>a+o.total,0), conversations: conversations.length, needsStaff: conversations.filter(c=>c.mode==='human').length, monthlySpend: usage.filter(u=>u.createdAt.startsWith(since)).reduce((a,u)=>a+u.costUsd,0), daily: Array.from({length:30},(_,i)=>{const date = new Date(Date.now() - (29-i)*86400000).toISOString().slice(0,10);return {date,count:orders.filter(o=>o.createdAt.startsWith(date)).length};}) };
}
