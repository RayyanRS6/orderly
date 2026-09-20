import { z } from 'zod';
import type { Repository } from '../repository';
import type { Integration } from '../../src/shared/types';
import { requiredEnv } from '../config';
import { encryptSecret, PublicError } from '../security';
import { WhatsAppAdapter } from './whatsapp';
import { requireMeta, metaConfigurationBoundary } from '../whatsapp/connections';

export const signupSchema = z.object({
  code: z.string().min(1).max(5000),
  phoneNumberId: z.string().regex(/^\d+$/),
  wabaId: z.string().regex(/^\d+$/),
  coexistence: z.boolean(),
  pin: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
});
export async function finishSignup(
  repo: Repository,
  companyId: string,
  body: z.infer<typeof signupSchema>,
) {
  await requireMeta(repo, companyId);
  const existing = await repo.findCompanyByPhoneNumberId(body.phoneNumberId);
  if (existing && existing.id !== companyId)
    throw new PublicError('That number already belongs to another workspace.', 409);
  const version = requiredEnv('META_GRAPH_VERSION');
  if (!/^v\d+\.\d+$/.test(version)) throw new PublicError('Invalid Meta Graph version.');
  const base = `https://graph.facebook.com/${version}`;
  const query = new URLSearchParams({
    client_id: requiredEnv('META_APP_ID'),
    client_secret: requiredEnv('META_APP_SECRET'),
    code: body.code,
  });
  const response = await fetch(`${base}/oauth/access_token?${query}`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok)
    throw new PublicError(
      'Meta could not exchange this signup code. Start the connection flow again.',
      502,
    );
  const result = (await response.json()) as { access_token?: string };
  if (!result.access_token) throw new PublicError('Meta returned no access token.', 502);
  // Never trust the account IDs arriving from the browser without checking the granted token.
  const verified = await fetch(`${base}/${body.wabaId}/phone_numbers?fields=id&limit=100`, {
    headers: { Authorization: `Bearer ${result.access_token}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!verified.ok)
    throw new PublicError('The granted token cannot access this WhatsApp account.', 403);
  const numbers = (await verified.json()) as { data?: { id: string }[] };
  if (!numbers.data?.some((number) => number.id === body.phoneNumberId))
    throw new PublicError('The phone number does not belong to the granted WhatsApp account.', 403);
  const integration: Integration = {
    kind: 'whatsapp',
    configured: true,
    status: 'configured',
    config: {
      phoneNumberId: body.phoneNumberId,
      wabaId: body.wabaId,
      coexistence: String(body.coexistence),
      statusTemplate: 'orderly_order_status',
      templateLanguage: 'en',
    },
  };
  const adapter = new WhatsAppAdapter(integration, result.access_token);
  await adapter.subscribe();
  if (!body.coexistence && body.pin) await adapter.register(body.pin);
  // Activate only after all requested external steps succeed. A failed attempt
  // must not replace an already working workspace connection.
  integration.config.ownershipVerifiedAt = new Date().toISOString();
  await metaConfigurationBoundary(repo, companyId, body.phoneNumberId);
  await repo.saveIntegration(companyId, integration, encryptSecret(result.access_token));
  return {
    integration,
    message: body.coexistence
      ? 'Account connected. Verify coexistence messages with the restaurant before enabling the bot.'
      : body.pin
        ? 'Account connected and number registered. Test delivery before enabling the bot.'
        : 'Account connected. Register the number with its six-digit PIN, then test delivery before enabling the bot.',
  };
}
