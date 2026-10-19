import { z } from 'zod';

export const connectionStatus = z.enum([
  'disconnected',
  'awaiting_pairing',
  'connecting',
  'connected',
  'reconnecting',
  'logged_out',
  'error',
]);
export type WhatsAppConnection = {
  id: string;
  companyId: string;
  provider: 'meta' | 'baileys';
  generation: number;
  revision: number;
  status: z.infer<typeof connectionStatus>;
  pairingMethod?: 'qr' | 'code';
  accountJid?: string;
  phoneNumber?: string;
  pushName?: string;
  lastHeartbeatAt?: string;
  errorCode?: string;
  updatedAt: string;
};
// A connected linked phone reports to Orderly about once a minute (each report is one Supabase
// function call). Replies are refused once the last report received is over 3 minutes old: one
// missed or late report is harmless, but two missed in a row can already reach the limit.
export const GATEWAY_HEARTBEAT_MS = 60000;
export const GATEWAY_HEARTBEAT_STALE_MS = 180000;
export type WhatsAppAddress = {
  connectionId: string;
  generation: number;
  provider: 'meta' | 'baileys';
  peer: string;
};
export const addressSchema = z
  .object({
    connectionId: z.string().uuid(),
    generation: z.number().int().positive(),
    provider: z.enum(['meta', 'baileys']),
    peer: z.string().min(1).max(100),
  })
  .strict();
export const directJidSchema = z.string().regex(/^\d{5,20}@(s\.whatsapp\.net|lid)$/);
export const gatewayEventSchema = z
  .object({
    eventId: z.string().uuid(),
    connectionId: z.string().uuid(),
    generation: z.number().int().positive(),
    type: z.enum(['status', 'message', 'receipt']),
    status: connectionStatus.optional(),
    // A customer's phone confirmed one of our messages (two grey or two blue ticks).
    receipt: z.enum(['delivered', 'read']).optional(),
    errorCode: z.string().max(80).optional(),
    accountJid: directJidSchema.optional(),
    phoneNumber: z
      .string()
      .regex(/^\+[1-9]\d{5,14}$/)
      .optional(),
    pushName: z.string().max(100).optional(),
    peer: directJidSchema.optional(),
    messageId: z.string().min(1).max(150).optional(),
    text: z.string().max(4000).optional(),
    fromMe: z.boolean().optional(),
    unsupported: z.boolean().optional(),
    timestamp: z.string().datetime(),
  })
  .strict();
export type GatewayEvent = z.infer<typeof gatewayEventSchema>;
export const sessionCommandSchema = z
  .object({
    connectionId: z.string().uuid(),
    generation: z.number().int().positive(),
    action: z.enum(['pair', 'reconnect', 'disconnect']),
    method: z.enum(['qr', 'code']).optional(),
    phone: z
      .string()
      .regex(/^[1-9]\d{5,14}$/)
      .optional(),
  })
  .strict();
export const sendCommandSchema = z
  .object({
    connectionId: z.string().uuid(),
    generation: z.number().int().positive(),
    idempotencyKey: z.string().min(1).max(200),
    peer: directJidSchema,
    text: z.string().min(1).max(4096),
    lastInboundAt: z.string().datetime(),
  })
  .strict();
// How a caption or a shared location reaches the bot as customer text, worded the same on both
// WhatsApp routes. The media itself is never downloaded; the marker tells the bot (and staff
// reading the chat) that something came with the words. No maps link is built: links in replies
// are checked against the restaurant's own.
export function captionText(caption: string, media: 'photo' | 'video' | 'document'): string {
  const marker = ` (sent with a ${media})`;
  return `${caption.trim().slice(0, 4000 - marker.length)}${marker}`;
}
export function locationText(location: {
  latitude?: number | null;
  longitude?: number | null;
  name?: string | null;
  address?: string | null;
}): string | undefined {
  const { latitude, longitude } = location;
  const parts = [location.name, location.address].map((part) => part?.replace(/\s+/g, ' ').trim());
  const place = [...new Set(parts.filter(Boolean))].join(', ').slice(0, 300);
  const valid =
    typeof latitude === 'number' &&
    typeof longitude === 'number' &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180;
  if (!valid && !place) return;
  const coordinates = valid ? `(${+latitude.toFixed(6)}, ${+longitude.toFixed(6)})` : '';
  return ['Location shared:', place, coordinates].filter(Boolean).join(' ');
}
// WhatsApp Business app greeting and away messages reach Orderly exactly like a reply staff typed
// on the phone, and WhatsApp marks them no differently. Not used yet: no setting lists those texts
// and nothing calls this, so today every greeting or away message pauses the bot for that chat,
// and owners turn them off instead (gateway/README.md). Kept for an opt-in rule where only an exact
// match (ignoring spacing) counts as automatic, so a staff quick reply still pauses the bot.
export const phoneAutoMessagesSchema = z.array(z.string().trim().min(1).max(1000)).max(5);
const autoMessageText = (text: string) => text.normalize('NFC').replace(/\s+/g, ' ').trim();
export function isPhoneAutoMessage(
  text: string | undefined,
  autoMessages: readonly string[] | undefined,
): boolean {
  const value = text ? autoMessageText(text) : '';
  return !!value && !!autoMessages?.some((entry) => autoMessageText(entry) === value);
}
export function sameAddress(a?: WhatsAppAddress, b?: WhatsAppAddress): boolean {
  return (
    !!a &&
    !!b &&
    a.connectionId === b.connectionId &&
    a.generation === b.generation &&
    a.provider === b.provider &&
    a.peer === b.peer
  );
}
/**
 * The identities a block matches, so it outlasts a reconnect or a switch between Meta and
 * the linked phone. A phone number (Meta sends bare digits, the gateway '+digits' or a phone
 * JID) becomes 'pn:<digits>'. A WhatsApp privacy ID ('…@lid') becomes 'lid:<digits>': it is
 * not a phone number and is never compared with one. Test chats have no keys.
 */
export function customerKeys({ phone, peer }: { phone?: string; peer?: string }): string[] {
  const keys = new Set<string>();
  const phoneKey = (value: string) => {
    const digits = value.replace(/[\s()+-]/g, '');
    if (/^[1-9]\d{5,14}$/.test(digits)) keys.add(`pn:${digits}`);
  };
  if (phone) phoneKey(phone);
  const jid = peer?.match(/^(\d{5,20})(?::\d+)?@(s\.whatsapp\.net|lid)$/);
  if (jid) {
    if (jid[2] === 'lid') keys.add(`lid:${jid[1]}`);
    else phoneKey(jid[1]);
  } else if (peer) phoneKey(peer);
  return [...keys];
}
export function connectionMatches(
  connection: WhatsAppConnection | undefined,
  address: WhatsAppAddress,
): boolean {
  return (
    !!connection &&
    connection.id === address.connectionId &&
    connection.generation === address.generation &&
    connection.provider === address.provider &&
    !['disconnected', 'logged_out'].includes(connection.status)
  );
}
