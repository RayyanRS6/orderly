import { normalizeMessageContent, proto } from '@whiskeysockets/baileys';

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
// So every message is judged on its own, never by the batch type. Answers to
// placeholder-resend requests (requestId) are still skipped, as before: a JID form that
// differs from the original would slip past the duplicate check.
export function upsertedMessages<T>(update: { messages: T[]; requestId?: string }): T[] {
  return update.requestId ? [] : update.messages;
}
// Edits, deletions, reactions, pins and poll votes arrive wrapped (editedMessage,
// ephemeralMessage, ...). They are not new customer messages: judged on the raw message,
// an edit looked like unsupported media and handed a normal order chat to staff.
export function chatContent(message?: proto.IMessage | null): proto.IMessage | undefined {
  const content = normalizeMessageContent(message);
  if (
    !content ||
    content.protocolMessage ||
    content.reactionMessage ||
    content.encReactionMessage ||
    content.pollUpdateMessage ||
    content.keepInChatMessage ||
    content.pinInChatMessage
  )
    return undefined;
  return content;
}
