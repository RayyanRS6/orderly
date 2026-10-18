import type { BotAction } from '../../src/shared/types';
import { captionText, locationText as sharedLocationText } from '../../src/shared/whatsapp';

// What a WhatsApp Cloud API message becomes. Pure, so every message type is testable offline.
// Reactions and system notices are not the customer writing to the restaurant: they create
// no job (so nothing is answered and the 24-hour reply window is not reopened) and leave
// only a trace with no message content. Only what Orderly cannot read goes to staff.

export type InboundContent =
  | { ignore: true; trace: { action: string; detail: string } }
  | { text: string; action?: BotAction };
// Loosely typed: these are webhook bodies from Meta, checked field by field.
type MetaMessage = Record<string, any>;

export const MEDIA_HANDOFF_TEXT = 'Customer sent a media message. Staff assistance requested.';
const MEDIA = ['image', 'video', 'document'] as const;
// Worded as on the linked phone (captionText): '<caption> (sent with a photo)', and so on. An
// Urdu caption is still read as Urdu: its own script decides the reply language.
const STAFF_MEDIA = { image: 'photo', video: 'video', document: 'document' } as const;
const IGNORED = new Map([
  ['reaction', 'A reaction to a message was ignored.'],
  ['system', 'A WhatsApp system notice was ignored.'],
  ['request_welcome', 'A WhatsApp welcome request was ignored.'],
]);
const clean = (value: unknown, max: number) =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
// Meta sends numbers; a number written as text is accepted too.
function coordinate(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  return typeof value === 'string' && /^-?\d{1,3}(?:\.\d+)?$/.test(value.trim())
    ? Number(value)
    : undefined;
}

/**
 * A shared location pin as one line of text, worded as on the linked phone (locationText in
 * src/shared/whatsapp.ts): 'Location shared: Gulberg III, Main Boulevard (31.5204, 74.3587)'.
 * Coordinates only, never a map link. Undefined when it holds nothing.
 */
export function locationText(location: unknown): string | undefined {
  if (!location || typeof location !== 'object') return undefined;
  const pin = location as Record<string, unknown>;
  return sharedLocationText({
    latitude: coordinate(pin.latitude),
    longitude: coordinate(pin.longitude),
    name: typeof pin.name === 'string' ? pin.name : undefined,
    address: typeof pin.address === 'string' ? pin.address : undefined,
  });
}

function captioned(message: MetaMessage) {
  for (const kind of MEDIA) {
    // Line breaks are kept: a caption often lists one dish per line.
    const value = message[kind]?.caption;
    const caption = typeof value === 'string' ? value.trim().slice(0, 1900) : '';
    if (caption) return { kind, caption };
  }
}

/** A customer's message: its text and button action, or nothing to answer. */
export function metaInboundContent(message: MetaMessage): InboundContent {
  const type = typeof message.type === 'string' ? message.type : '';
  // A reaction, or a reaction taken back (no emoji), is not a reply to the bot.
  const ignored = message.reaction ? 'reaction' : IGNORED.has(type) ? type : undefined;
  if (ignored)
    return {
      ignore: true,
      trace: { action: `whatsapp.${ignored}`, detail: IGNORED.get(ignored)! },
    };
  const text = String(
    message.text?.body ??
      message.interactive?.button_reply?.title ??
      message.interactive?.list_reply?.title ??
      '',
  ).slice(0, 2000);
  const button = String(
    message.interactive?.button_reply?.id ?? message.interactive?.list_reply?.id ?? '',
  );
  let action: BotAction | undefined;
  if (/^confirm:\d+$/.test(button))
    action = { type: 'confirm', revision: Number(button.split(':')[1]) };
  if (['menu', 'review', 'handoff', 'new_order'].includes(button))
    action = { type: button } as BotAction;
  if (text || action) return { text, ...(action && { action }) };
  // A template's quick-reply button: its label is what the customer chose. Never an action,
  // since the template's author, not Orderly, picks its payload.
  const tapped = clean(message.button?.text, 2000) || clean(message.button?.payload, 2000);
  if (tapped) return { text: tapped };
  const media = captioned(message);
  if (media) return { text: captionText(media.caption, STAFF_MEDIA[media.kind]) };
  const shared = locationText(message.location);
  if (shared) return { text: shared };
  // Voice notes, stickers, contacts, media without a caption and types Orderly does not read.
  return { text: MEDIA_HANDOFF_TEXT, action: { type: 'handoff' } };
}

/**
 * The note for a message staff sent from the WhatsApp Business app (coexistence), or
 * undefined when it should not pause the bot: a reaction or a system notice.
 */
export function metaEchoText(echo: MetaMessage): string | undefined {
  const type = typeof echo.type === 'string' ? echo.type.slice(0, 30) : '';
  if (echo.reaction || IGNORED.has(type)) return undefined;
  if (echo.text?.body !== undefined && echo.text.body !== null)
    return String(echo.text.body).slice(0, 2000);
  if (type === 'edit')
    return `Staff edited a message: ${echo.edit?.message?.text?.body ?? '[media]'}`.slice(0, 2000);
  if (type === 'revoke') return 'Staff deleted a message in WhatsApp.';
  const media = captioned(echo);
  if (media) return `Staff sent a ${STAFF_MEDIA[media.kind]} in WhatsApp: ${media.caption}`;
  const shared = locationText(echo.location);
  if (shared) return `Staff sent a location in WhatsApp. ${shared}`;
  return `Staff sent a ${type || 'media'} message in WhatsApp.`;
}
