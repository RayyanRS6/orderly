import type { Conversation } from '../../src/shared/types';
import type { Repository } from '../repository';
import { PublicError } from '../security';
import { gatewayRequest } from '../whatsapp/client';
import { assertCurrentAddress } from '../whatsapp/connections';
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
      Date.now() - Date.parse(connection.lastHeartbeatAt) > 90000
    )
      throw new PublicError(
        'WhatsApp is offline or its heartbeat expired. Reconnect the linked device.',
        409,
      );
    if (Date.now() - Date.parse(conversation.lastInboundAt) >= 86400000)
      throw new PublicError(
        'Orderly pauses unofficial replies after 24 hours without a customer message. Contact the customer manually.',
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
      'The unofficial connection does not support approved Meta templates. Staff must follow up outside the reply window.',
      422,
    );
  }
}
