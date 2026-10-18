import { randomUUID } from 'node:crypto';
import { proto, type WAMessage } from '@whiskeysockets/baileys';
import type { Store } from './store.js';
import type { GatewayEvent } from '../../src/shared/whatsapp.js';
import { canonicalJid, phoneFromJid } from './policy.js';
import { resolveRoute } from './routing.js';
import { safeMessageId } from './drain.js';

export type Placeholder = { native: string; timestamp: number; at: number };
// Baileys waits 5 s, asks the restaurant phone to resend the message, gives up after 15 s and
// emits an answer 0.5 s after it arrives. Wait well past that before telling staff.
export const PLACEHOLDER_WAIT_MS = 45000;
const PLACEHOLDER_LIMIT = 500;
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
// Placeholders whose content never came. Saved on disk, so a restart does not lose them.
export function expiredPlaceholders(store: Store, now: number) {
  return store
    .list<Placeholder>('placeholder')
    .filter((row) => now - row.value.at >= PLACEHOLDER_WAIT_MS);
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
