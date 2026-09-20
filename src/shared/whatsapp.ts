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
    type: z.enum(['status', 'message']),
    status: connectionStatus.optional(),
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
