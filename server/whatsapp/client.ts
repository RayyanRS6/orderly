import { z } from 'zod';
import { appMode, env } from '../config';
import { PublicError } from '../security';
import { signedHeaders } from './signing';
import { connectionStatus } from '../../src/shared/whatsapp';

export const gatewaySnapshotSchema = z.object({
  connectionId: z.string().uuid(),
  generation: z.number().int().positive(),
  status: connectionStatus,
  qr: z
    .string()
    .max(50000)
    .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/)
    .optional(),
  code: z.string().max(16).optional(),
  expiresAt: z.string().datetime().optional(),
  errorCode: z.string().max(80).optional(),
});
export type GatewaySnapshot = z.infer<typeof gatewaySnapshotSchema>;
export function gatewayAvailable(): boolean {
  return (
    appMode() === 'live' &&
    env('WHATSAPP_GATEWAY_ENABLED') === 'true' &&
    !!env('WHATSAPP_GATEWAY_URL') &&
    (env('WHATSAPP_GATEWAY_SECRET')?.length ?? 0) >= 32
  );
}
export function gatewaySecret(): string {
  if (!gatewayAvailable())
    throw new PublicError(
      'The self-hosted WhatsApp gateway is not enabled. Ask the platform administrator to deploy and configure it.',
      503,
    );
  return env('WHATSAPP_GATEWAY_SECRET')!;
}
// What a refused gateway command means for the owner, by the gateway's errorCode. The code itself
// also reaches the dashboard (PublicError.code), which may say it in its own words.
const GATEWAY_REFUSALS: Record<string, string> = {
  SESSION_CAPACITY_REACHED:
    'Orderly’s linked-phone service is full right now. Contact Orderly support.',
  PAIRING_REQUIRED: 'Start a new pairing first.',
  PAIRING_EXPIRED: 'The pairing code expired. Start pairing again.',
  STALE_GENERATION: 'This WhatsApp connection changed meanwhile. Reload the page and try again.',
};
export async function gatewayRequest(path: string, body: unknown): Promise<unknown> {
  const secret = gatewaySecret();
  const url = new URL(env('WHATSAPP_GATEWAY_URL')!);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new PublicError('Gateway URL must be an HTTPS origin.', 503);
  const raw = JSON.stringify(body);
  let response: Response;
  try {
    response = await fetch(new URL(path, url), {
      method: 'POST',
      body: raw,
      headers: signedHeaders(secret, 'command', path, raw),
      signal: AbortSignal.timeout(20000),
      redirect: 'error',
    });
  } catch {
    // Only a send can be left pending; pairing, status and session commands are simply retried.
    throw new PublicError(
      path === '/send'
        ? 'The WhatsApp gateway is unreachable. A send may still be pending; retries reuse the same message identifier.'
        : 'The WhatsApp gateway is unreachable right now. Try again in a few minutes.',
      503,
    );
  }
  if (!response.ok) {
    const result = (await response.json().catch(() => ({}))) as { errorCode?: unknown };
    const code =
      typeof result?.errorCode === 'string' && /^[A-Z0-9_]{1,60}$/.test(result.errorCode)
        ? result.errorCode
        : undefined;
    if (code === 'SEND_UNCERTAIN')
      throw new PublicError(
        'WhatsApp send outcome is uncertain. Check the phone before sending again; automatic resend is blocked.',
        422,
        { code },
      );
    throw new PublicError(
      (code && GATEWAY_REFUSALS[code]) ??
        `WhatsApp gateway rejected the request (${response.status}). Check the connection status.`,
      response.status === 409 ? 409 : 503,
      { code },
    );
  }
  return response.json();
}
