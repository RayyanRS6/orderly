import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

// Direction and path are part of the MAC; a callback cannot be replayed as a command.
export function signedHeaders(
  secret: string,
  direction: 'command' | 'event',
  path: string,
  raw: string,
) {
  const timestamp = String(Date.now());
  const nonce = randomUUID();
  const signature = createHmac('sha256', secret)
    .update(`${direction}\nPOST\n${path}\n${timestamp}\n${nonce}\n${raw}`)
    .digest('hex');
  return {
    'Content-Type': 'application/json',
    'x-orderly-time': timestamp,
    'x-orderly-nonce': nonce,
    'x-orderly-signature': signature,
  };
}
export function verifySigned(
  secret: string,
  direction: 'command' | 'event',
  path: string,
  raw: string,
  headers: Headers,
): string | undefined {
  const timestamp = headers.get('x-orderly-time') || '';
  const nonce = headers.get('x-orderly-nonce') || '';
  const signature = headers.get('x-orderly-signature') || '';
  if (
    !/^\d{13}$/.test(timestamp) ||
    Math.abs(Date.now() - Number(timestamp)) > 60000 ||
    !/^[a-f0-9-]{36}$/.test(nonce) ||
    !/^[a-f0-9]{64}$/.test(signature)
  )
    return;
  const expected = createHmac('sha256', secret)
    .update(`${direction}\nPOST\n${path}\n${timestamp}\n${nonce}\n${raw}`)
    .digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) return;
  return nonce;
}
