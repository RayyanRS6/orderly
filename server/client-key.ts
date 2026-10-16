import { hmacKey22 } from './security.js';

/**
 * A rate-limit key for the visitor's network address: a keyed hash, so stored keys never hold
 * an IP address. Undefined when no address header is present (the per-IP limit is skipped).
 */
export function clientKey(headers: Headers): string | undefined {
  const ip =
    headers.get('cf-connecting-ip')?.trim() ||
    headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    headers.get('x-real-ip')?.trim();
  return ip ? hmacKey22('client-ip', ip) : undefined;
}
