import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { appMode, env, requiredEnv } from './config.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function encryptionKey(): Buffer {
  let encoded = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!encoded && appMode() === 'demo') {
    const dir = join(process.cwd(), '.local');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'credential.key');
    if (!existsSync(file))
      writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600, flag: 'wx' });
    encoded = readFileSync(file, 'utf8').trim();
  }
  if (!encoded) throw new Error('Set CREDENTIAL_ENCRYPTION_KEY to a base64-encoded 32-byte key.');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32)
    throw new Error('CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes.');
  return key;
}
// Keys for the menu page, derived from one base so nothing new must be set at deploy time:
// MENU_LINK_SECRET when set, otherwise the credential encryption key. Changing the base ends
// the personal links and order codes issued with it.
export function derivedKey(label: 'menu-link' | 'menu-draft' | 'client-ip'): Buffer {
  const override = env('MENU_LINK_SECRET');
  let base: Buffer;
  if (override) {
    base = Buffer.from(override, 'base64');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(override) || base.length < 32)
      throw new Error('MENU_LINK_SECRET must be base64 of at least 32 bytes.');
  } else base = encryptionKey();
  return createHmac('sha256', base).update(`orderly:${label}:v1`).digest();
}
export const hmacHex = (label: Parameters<typeof derivedKey>[0], value: string) =>
  createHmac('sha256', derivedKey(label)).update(value).digest('hex');
export const hmacKey22 = (label: Parameters<typeof derivedKey>[0], value: string) =>
  createHmac('sha256', derivedKey(label)).update(value).digest('base64url').slice(0, 22);
export function encryptSecret(value: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), nonce);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [nonce, cipher.getAuthTag(), encrypted].map((x) => x.toString('base64url')).join('.');
}
export function decryptSecret(value: string): string {
  const [nonce, tag, ciphertext] = value.split('.').map((x) => Buffer.from(x, 'base64url'));
  if (!nonce || !tag || !ciphertext) throw new Error('Invalid encrypted credential.');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function verifyMetaSignature(rawBody: string, signature: string | undefined): boolean {
  if (!signature?.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', requiredEnv('META_APP_SECRET')).update(rawBody).digest('hex')}`;
  return safeEqual(signature, expected);
}
export function sanitizeError(error: unknown): string {
  // SDK exceptions can include authorization headers or full upstream response bodies.
  if (error instanceof PublicError) return error.message;
  return 'The service could not complete this request. Check the connection and try again.';
}
export class PublicError extends Error {
  constructor(
    message: string,
    public status = 400,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
export const LAST_OWNER_MESSAGE =
  'Every business needs at least one owner. Add another owner first. You also can’t remove or demote yourself.';
