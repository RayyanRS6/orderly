import { proto } from '@whiskeysockets/baileys';

// The ticks a customer's phone sends back for one of our replies.
const RECEIPTS: Partial<Record<number, 'delivered' | 'read'>> = {
  [proto.WebMessageInfo.Status.DELIVERY_ACK]: 'delivered',
  [proto.WebMessageInfo.Status.READ]: 'read',
  [proto.WebMessageInfo.Status.PLAYED]: 'read',
};
export function receiptStatus(status?: number | null): 'delivered' | 'read' | undefined {
  return status == null ? undefined : RECEIPTS[status];
}
// Baileys merges events while it buffers them, and sending a reply starts a buffer that
// lasts until the next incoming node. A whole 'messages.upsert' batch then takes the type
// of its first message, so a customer's live message can arrive labelled 'append' behind
// our own reply; messages delivered after a reconnect are 'append' too. A delivery tick
// can also be folded into our reply's upsert instead of arriving as 'messages.update'.
// So every message is judged on its own, never by the batch type. Only answers to
// placeholder-resend requests (requestId) are skipped: they repeat messages already seen.
export function upsertedMessages<T>(update: { messages: T[]; requestId?: string }): T[] {
  return update.requestId ? [] : update.messages;
}
