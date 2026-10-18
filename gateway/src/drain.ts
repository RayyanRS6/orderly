import { createHash } from 'node:crypto';
import type { Store } from './store.js';
import type { GatewayEvent } from '../../src/shared/whatsapp.js';

export const EVENT_BATCH = 50;
// Responses Orderly gives for an event it can never accept (a schema or size problem). Any
// other failure (network, 401, 409, 429, 5xx) is retried with the event kept in place.
const REJECTED = [400, 413, 422];
const DEAD_LIMIT = 500;
const DEAD_RETRY_MS = 3600000;
const REPLY_WINDOW_MS = 86400000;
// Posts one signed event to Orderly and returns the HTTP status; throws when unreachable.
export type PostEvent = (raw: string) => Promise<number>;
export type DeadEvent = { event: GatewayEvent; reason: string; at: number; triedAt: number };
// Orderly accepts message IDs up to 150 characters. Longer ones (only a modified client sends
// them) are replaced by a stable hash, so the same message still deduplicates.
export function safeMessageId(id: string): string {
  return id.length > 150 ? `h:${createHash('sha256').update(id).digest('hex')}` : id;
}
// A rejected message is set aside instead of holding every later customer message behind it.
// The set is bounded, kept encrypted like the queue and cleared with it on re-pairing.
export function deadLetter(
  store: Store,
  id: string,
  event: GatewayEvent,
  reason: string,
  now: number,
) {
  store.transaction(() => {
    if (store.count('dead-events') >= DEAD_LIMIT) {
      const [oldest] = store.list('dead-events', 1);
      if (oldest) store.delete('dead-events', oldest.id);
    }
    store.set('dead-events', id, { event, reason, at: now, triedAt: now } satisfies DeadEvent);
    store.delete('events', id);
  });
}
// Returns how many queued messages were handled, or false when Orderly could not take them.
export async function drainOnce(
  store: Store,
  post: PostEvent,
  interrupted: () => boolean = () => false,
  now = Date.now,
): Promise<number | false> {
  // Status first so the backend knows the account before accepting messages, and
  // receipts last: they are informational and must never hold up a customer message.
  const rows = [
    ...store.list<GatewayEvent>('status-event').map((r) => ({ ...r, namespace: 'status-event' })),
    ...store.list<GatewayEvent>('events', EVENT_BATCH).map((r) => ({ ...r, namespace: 'events' })),
    ...store
      .list<GatewayEvent>('receipt-events', EVENT_BATCH)
      .map((r) => ({ ...r, namespace: 'receipt-events' })),
  ];
  let messages = 0;
  for (const row of rows) {
    // A customer message saved meanwhile goes before the remaining ticks.
    if (row.namespace === 'receipt-events' && interrupted()) break;
    let status: number;
    try {
      status = await post(JSON.stringify(row.value));
    } catch {
      return false;
    }
    if (status < 200 || status > 299) {
      // A rejected receipt is dropped; it is only a tick in the inbox.
      if (row.namespace === 'receipt-events' && status < 500) {
        store.delete(row.namespace, row.id);
        continue;
      }
      // A message Orderly can never accept is set aside with its reason; later messages go on.
      // A status that fails blocks the rest: it carries the account they belong to.
      if (row.namespace === 'events' && REJECTED.includes(status)) {
        deadLetter(store, row.id, row.value, `HTTP_${status}`, now());
        messages++;
        continue;
      }
      // Never silently discard a message or endlessly grow memory. Backend failures
      // are retried from encrypted disk.
      return false;
    }
    if (store.get<GatewayEvent>(row.namespace, row.id)?.eventId === row.value.eventId)
      store.delete(row.namespace, row.id);
    if (row.namespace === 'events') messages++;
  }
  return messages;
}
// Set-aside messages are offered again about hourly while a reply could still help (for
// example once a backend that lagged behind the gateway is deployed), then deleted.
export async function retryDeadEvents(store: Store, post: PostEvent, now = Date.now()) {
  for (const row of store.list<DeadEvent>('dead-events')) {
    const { event, triedAt } = row.value;
    if (now - Date.parse(event.timestamp) > REPLY_WINDOW_MS) {
      store.delete('dead-events', row.id);
      continue;
    }
    if (now - triedAt < DEAD_RETRY_MS) continue;
    let status: number;
    try {
      status = await post(JSON.stringify(event));
    } catch {
      return;
    }
    if (status >= 200 && status <= 299) store.delete('dead-events', row.id);
    else store.set('dead-events', row.id, { ...row.value, triedAt: now });
  }
}
