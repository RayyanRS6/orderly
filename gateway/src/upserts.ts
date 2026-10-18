import { normalizeMessageContent, proto } from '@whiskeysockets/baileys';
import { captionText, locationText } from '../../src/shared/whatsapp.js';

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
// So every message is judged on its own, never by the batch type. An answer to a
// placeholder-resend request (requestId) is the restaurant phone's copy of a customer message
// this device received empty. Only copies of a placeholder we are still holding are taken; the
// worker files them under the placeholder's chat, whatever JID form the phone uses.
export function upsertedMessages<T extends { key: { id?: string | null } }>(
  update: { messages: T[]; requestId?: string },
  held: (id: string) => boolean = () => false,
): T[] {
  return update.requestId
    ? update.messages.filter((message) => !!message.key.id && held(message.key.id))
    : update.messages;
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
// The text the bot reads. A photo, video or document caption and a shared location become text
// (worded as on the Meta route); a live location is read as the place it started from, with its
// caption. A quick-reply or list choice is its visible label. Anything else without text (voice
// notes, stickers, contacts, uncaptioned media) returns '' and is handed to staff, who see it on
// the phone.
export function messageText(content: proto.IMessage): string {
  const text = content.conversation || content.extendedTextMessage?.text;
  if (text) return text.slice(0, 4000);
  const media = [
    ['photo', content.imageMessage],
    ['video', content.videoMessage],
    ['document', content.documentMessage],
  ] as const;
  for (const [kind, value] of media)
    if (value?.caption?.trim()) return captionText(value.caption, kind);
  const location = content.locationMessage;
  const live = content.liveLocationMessage;
  if (location || live)
    return (
      locationText({
        latitude: (location ?? live)!.degreesLatitude,
        longitude: (location ?? live)!.degreesLongitude,
        name: location ? location.name : live!.caption,
        address: location?.address,
      }) ?? ''
    );
  const choice =
    content.buttonsResponseMessage?.selectedDisplayText ||
    content.templateButtonReplyMessage?.selectedDisplayText ||
    content.listResponseMessage?.title;
  return choice?.trim().slice(0, 4000) ?? '';
}
