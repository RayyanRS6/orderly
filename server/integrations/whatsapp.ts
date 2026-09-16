import type { Conversation, Integration } from '../../src/shared/types.js';
import { PublicError } from '../security.js';
export interface ChannelAdapter {
  send(conversation: Conversation, text: string): Promise<string>;
}
export class WhatsAppAdapter implements ChannelAdapter {
  constructor(
    private integration: Integration,
    private token: string,
  ) {}
  private base(): string {
    const version = process.env.META_GRAPH_VERSION;
    if (!version || !/^v\d+\.\d+$/.test(version))
      throw new PublicError(
        'Set META_GRAPH_VERSION to a supported Graph API version from your Meta app.',
      );
    return `https://graph.facebook.com/${version}`;
  }
  private async request(path: string, init: RequestInit = {}): Promise<any> {
    const response = await fetch(`${this.base()}/${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok)
      throw new PublicError(
        response.status === 401 || response.status === 403
          ? 'Meta rejected the token or permissions. Reconnect WhatsApp.'
          : 'WhatsApp could not complete the request. Check account health in Meta.',
        502,
      );
    return response.json();
  }
  async test(): Promise<void> {
    const id = this.integration.config.phoneNumberId;
    if (!/^\d+$/.test(id || ''))
      throw new PublicError('A numeric WhatsApp phone number ID is required.');
    await this.request(`${id}?fields=id,display_phone_number,verified_name`);
  }
  async verifyOwnership(): Promise<void> {
    const { wabaId, phoneNumberId } = this.integration.config;
    if (!/^\d+$/.test(wabaId || '') || !/^\d+$/.test(phoneNumberId || ''))
      throw new PublicError('Numeric business account and phone number IDs are required.');
    let after = '';
    for (let page = 0; page < 20; page++) {
      const result = await this.request(`${wabaId}/phone_numbers?fields=id&limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`);
      if (result.data?.some((number: { id: string }) => number.id === phoneNumberId)) return;
      const next = result.paging?.cursors?.after;
      if (!result.paging?.next || !next || next === after) break;
      after = next;
    }
    throw new PublicError('This token does not grant access to that phone number in the selected business account.', 403);
  }
  async unsubscribe(): Promise<void> {
    const waba = this.integration.config.wabaId;
    if (/^\d+$/.test(waba || '')) await this.request(`${waba}/subscribed_apps`, { method: 'DELETE' });
  }
  async subscribe(): Promise<unknown> {
    const waba = this.integration.config.wabaId;
    if (!/^\d+$/.test(waba || ''))
      throw new PublicError('A numeric WhatsApp Business Account ID is required.');
    return this.request(`${waba}/subscribed_apps`, { method: 'POST', body: '{}' });
  }
  async register(pin: string): Promise<unknown> {
    if (this.integration.config.coexistence === 'true')
      throw new PublicError(
        'This number uses the WhatsApp Business mobile app. Complete coexistence onboarding instead of standard registration.',
        409,
      );
    return this.request(`${this.integration.config.phoneNumberId}/register`, {
      method: 'POST',
      body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
    });
  }
  async send(conversation: Conversation, text: string): Promise<string> {
    if (conversation.channel !== 'whatsapp')
      throw new PublicError('Test conversations cannot send WhatsApp messages.');
    const inWindow = Date.now() - Date.parse(conversation.lastInboundAt) < 24 * 60 * 60 * 1000;
    if (!inWindow)
      throw new PublicError(
        'The 24-hour reply window has closed. Send an approved status template or wait for the customer to message again.',
        409,
      );
    const review =
      conversation.cart.status === 'awaiting_confirmation' && conversation.mode === 'bot';
    const payload = {
      messaging_product: 'whatsapp',
      to: conversation.customerPhone,
      ...(review && text.length <= 1024
        ? {
            type: 'interactive',
            interactive: {
              type: 'button',
              body: { text },
              action: {
                buttons: [
                  {
                    type: 'reply',
                    reply: {
                      id: `confirm:${conversation.cart.reviewedRevision}`,
                      title: 'Confirm order',
                    },
                  },
                  { type: 'reply', reply: { id: 'handoff', title: 'Talk to staff' } },
                ],
              },
            },
          }
        : { type: 'text', text: { body: text.slice(0, 4096) } }),
    };
    const data = await this.request(`${this.integration.config.phoneNumberId}/messages`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return data.messages?.[0]?.id ?? '';
  }
  async sendStatusTemplate(
    conversation: Conversation,
    reference: string,
    status: string,
  ): Promise<string> {
    if (conversation.channel !== 'whatsapp')
      throw new PublicError('Test conversations cannot send WhatsApp messages.');
    const name = this.integration.config.statusTemplate;
    if (!name)
      throw new PublicError(
        'Configure an approved order-status template to send updates outside the reply window.',
        409,
      );
    const data = await this.request(`${this.integration.config.phoneNumberId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: conversation.customerPhone,
        type: 'template',
        template: {
          name,
          language: { code: this.integration.config.templateLanguage || 'en' },
          components: [
            {
              type: 'body',
              parameters: [
                { type: 'text', text: reference },
                { type: 'text', text: status },
              ],
            },
          ],
        },
      }),
    });
    return data.messages?.[0]?.id ?? '';
  }
  async createStatusTemplate(): Promise<unknown> {
    const waba = this.integration.config.wabaId;
    if (!/^\d+$/.test(waba || ''))
      throw new PublicError('Add the WhatsApp Business Account ID first.');
    return this.request(`${waba}/message_templates`, {
      method: 'POST',
      body: JSON.stringify({
        name: this.integration.config.statusTemplate || 'orderly_order_status',
        language: this.integration.config.templateLanguage || 'en',
        category: 'UTILITY',
        components: [
          {
            type: 'BODY',
            text: 'Your order {{1}} is now {{2}}.',
            example: { body_text: [['ORD-12345', 'accepted']] },
          },
        ],
      }),
    });
  }
}
