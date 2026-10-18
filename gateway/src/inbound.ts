import { createHash, randomUUID } from 'node:crypto';
import { proto, type WAMessage } from '@whiskeysockets/baileys';
import type { Store } from './store.js';
import type { GatewayEvent } from '../../src/shared/whatsapp.js';
import { canonicalJid, phoneFromJid } from './policy.js';
import { resolveRoute } from './routing.js';
import { safeMessageId } from './drain.js';

// released: when staff were told the content never came. The placeholder is kept until the
// message is a day old, so a copy that still arrives is filed in the same chat.
export type Placeholder = { native: string; timestamp: number; at: number; released?: number };
// Baileys waits 5 s, asks the restaurant phone to resend the message, gives up after 15 s and
// emits an answer 0.5 s after it arrives. Wait well past that before telling staff.
export const PLACEHOLDER_WAIT_MS = 45000;
const PLACEHOLDER_LIMIT = 500;
const DAY_MS = 86400000;
// The notice to staff goes under its own message ID, the original's with this suffix (Orderly
// words it as unreadable), so the real message keeps its ID if it still arrives.
export const UNREAD_SUFFIX = ':unread';
export function unreadId(id: string): string {
  const base =
    id.length + UNREAD_SUFFIX.length > 150
      ? `h:${createHash('sha256').update(id).digest('hex')}`
      : id;
  return `${base}${UNREAD_SUFFIX}`;
}
// A customer message the linked device received without its content: WhatsApp marked it
// unavailable here, or it could not be decrypted. The phone's resend or the sender's retry
// usually delivers it shortly after.
export function awaitsContent(message: WAMessage): boolean {
  return (
    message.messageStubType === proto.WebMessageInfo.StubType.CIPHERTEXT &&
    !message.message &&
    !message.key.fromMe
  );
}
export function holdPlaceholder(
  store: Store,
  id: string,
  native: string,
  timestamp: number,
  now: number,
) {
  if (store.get('placeholder', id) || store.count('placeholder') >= PLACEHOLDER_LIMIT) return;
  store.set('placeholder', id, { native, timestamp, at: now } satisfies Placeholder);
}
// Placeholders whose content never came, to tell staff about once. Saved on disk, so a restart
// does not lose them. Ones whose message was taken meanwhile or is a day old are removed.
export function expiredPlaceholders(store: Store, now: number) {
  const due: { id: string; value: Placeholder }[] = [];
  for (const row of store.list<Placeholder>('placeholder')) {
    if (row.value.timestamp < now - DAY_MS || isSeen(store, row.value.native, row.id, false))
      store.delete('placeholder', row.id);
    else if (!row.value.released && now - row.value.at >= PLACEHOLDER_WAIT_MS) due.push(row);
  }
  return due;
}
// Tells staff (as unsupported media is) about a customer message whose content never reached
// this device, instead of letting it vanish. The real message ID is not used up, so a sender
// retry that comes later still reaches Orderly, in the same chat.
export function releasePlaceholder(
  store: Store,
  input: { connectionId: string; generation: number; id: string; placeholder: Placeholder },
  now: number,
): GatewayEvent {
  const { placeholder } = input;
  const event = queueMessage(store, {
    connectionId: input.connectionId,
    generation: input.generation,
    native: placeholder.native,
    id: unreadId(input.id),
    timestamp: placeholder.timestamp,
    text: '',
    fromMe: false,
  });
  // After the notice: a stop in between only repeats it, and Orderly drops the repeat by its ID.
  store.set('placeholder', input.id, { ...placeholder, released: now } satisfies Placeholder);
  return event;
}
// A message without chat content. A customer message whose content may still come is held; a
// copy of a held one that turned out to be a reaction, an edit or a deletion settles it, as
// there is no new customer message for staff.
export function withoutContent(
  store: Store,
  message: WAMessage,
  target: { id: string; native: string; held: boolean; fromMe: boolean },
  timestamp: number,
  now: number,
) {
  if (target.held && message.message) {
    store.transaction(() => {
      store.delete('placeholder', target.id);
      store.set('seen-id', target.id, now);
    });
    return;
  }
  if (awaitsContent(message) && !isSeen(store, target.native, target.id, target.fromMe))
    holdPlaceholder(store, target.id, target.native, timestamp, now);
}
// The chat a message is filed under. A copy the phone resent for a placeholder belongs to the
// chat the placeholder came in, whatever JID form the phone uses, and is a customer message.
export function inboundTarget(store: Store, message: WAMessage) {
  const id = message.key.id;
  const held = id ? store.get<Placeholder>('placeholder', id) : undefined;
  const native = held?.native ?? canonicalJid(message.key.remoteJid);
  if (!native || !id) return;
  return { id, native, held: !!held, fromMe: !held && !!message.key.fromMe };
}
// Customer messages are deduplicated by message ID alone, so a copy filed under another JID
// form (a placeholder resend, a LID switch) is not answered twice. Staff echoes keep the
// per-chat key; older per-chat entries still count.
const seenKey = (native: string, id: string, fromMe: boolean): [string, string] =>
  fromMe ? ['seen', `${native}:${id}`] : ['seen-id', id];
export function isSeen(store: Store, native: string, id: string, fromMe: boolean) {
  return !!store.get(...seenKey(native, id, fromMe)) || !!store.get('seen', `${native}:${id}`);
}
// Durable dedupe and enqueue commit together, before the model can be called.
export function queueMessage(
  store: Store,
  input: {
    connectionId: string;
    generation: number;
    native: string;
    id: string;
    timestamp: number;
    text: string;
    fromMe: boolean;
  },
): GatewayEvent {
  const { native, id, fromMe, text } = input;
  const { peer, phoneJid } = resolveRoute(store, native);
  return store.transaction(() => {
    store.set('route', native, peer);
    const value: GatewayEvent = {
      eventId: randomUUID(),
      connectionId: input.connectionId,
      generation: input.generation,
      type: 'message',
      peer,
      messageId: safeMessageId(id),
      text,
      fromMe,
      unsupported: !text,
      phoneNumber: phoneFromJid(phoneJid),
      timestamp: new Date(input.timestamp).toISOString(),
    };
    store.set('events', value.eventId, value);
    store.set(...seenKey(native, id, fromMe), Date.now());
    store.delete('placeholder', id);
    return value;
  });
}
