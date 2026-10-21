import type { Conversation } from '../../src/shared/types';
import type { Repository } from '../repository';
import { PublicError } from '../security';
import { gatewayRequest } from '../whatsapp/client';
import { assertCurrentAddress } from '../whatsapp/connections';
import { GATEWAY_HEARTBEAT_STALE_MS } from '../../src/shared/whatsapp';
import { z } from 'zod';

export class LinkedWhatsAppAdapter {
  constructor(
    private repo: Repository,
    private companyId: string,
    private jobId: string,
  ) {}
  async send(conversation: Conversation, text: string) {
    if (conversation.channel !== 'whatsapp')
      throw new PublicError('Sandbox cannot send WhatsApp messages.', 422);
    const address = await assertCurrentAddress(
      this.repo,
      this.companyId,
      conversation.whatsappAddress,
    );
    if (!address || address.provider !== 'baileys')
      throw new PublicError('Invalid linked-device destination.', 422);
    const connection = await this.repo.getWhatsAppConnection(this.companyId);
    if (
      connection?.status !== 'connected' ||
      !connection.lastHeartbeatAt ||
      Date.now() - Date.parse(connection.lastHeartbeatAt) > GATEWAY_HEARTBEAT_STALE_MS
    )
      throw new PublicError(
        'WhatsApp is offline or its heartbeat expired. Reconnect the linked device.',
        409,
      );
    if (Date.now() - Date.parse(conversation.lastInboundAt) >= 86400000)
      throw new PublicError(
        'Not sent: the customer last wrote more than 24 hours ago, and WhatsApp doesn’t allow automatic messages from a linked phone after that. Message the customer yourself.',
        422,
      );
    return z.object({ messageId: z.string().min(1) }).parse(
      await gatewayRequest('/send', {
        connectionId: address.connectionId,
        generation: address.generation,
        peer: address.peer,
        text,
        idempotencyKey: this.jobId,
        lastInboundAt: conversation.lastInboundAt,
      }),
    ).messageId;
  }
  async sendStatusTemplate(): Promise<string> {
    throw new PublicError(
      'Not sent: the customer last wrote more than 24 hours ago. After that WhatsApp only allows its pre-approved messages, which a linked phone can’t send. Message the customer yourself.',
      422,
    );
  }
}
