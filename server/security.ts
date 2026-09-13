import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { appMode, requiredEnv } from './config.js';
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
