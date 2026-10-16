import { createHmac, timingSafeEqual } from 'node:crypto';
import { derivedKey } from './security.js';

// Personal menu links (…/m/<slug>#t=<token>). The token is signed, never stored, and made the
// same way every time for one send job, so a retried send carries exactly the same text (the
// linked-phone gateway refuses a retry with different text). Layout, 65 bytes, base64url:
//   [0] version 1 · [1..4] expiry (Unix seconds) · [5..20] conversation id · [21..36] connection
//   id (zeros for chats without one) · [37..40] generation · [41..48] nonce · [49..64] MAC
// The MAC covers the business id too, so a token never works on another business's page.

export const MENU_LINK_TTL_MS = 7_200_000;
const SKEW_MS = 5 * 60 * 1000;
const LENGTH = 65;

export interface MenuTokenClaims {
  conversationId: string;
  connectionId?: string;
  generation?: number;
  expiresAt: string;
  /** 11 base64url characters: one order per link. */
  nonce: string;
}
export type MenuTokenCheck =
  { ok: true; claims: MenuTokenClaims } | { ok: false; reason: 'invalid' | 'expired' };

const uuidBytes = (value: string) => {
  const hex = value.replaceAll('-', '');
  return /^[0-9a-f]{32}$/i.test(hex) ? Buffer.from(hex, 'hex') : undefined;
};
const uuidText = (bytes: Buffer) => {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const mac = (key: Buffer, companyId: string, body: Buffer) =>
  createHmac('sha256', key)
    .update(Buffer.concat([Buffer.from(`orderly-menu-link:v1:${companyId}\0`), body]))
    .digest()
    .subarray(0, 16);

/** The token for one send job, or undefined when it cannot be made (the public link is sent). */
export function signMenuToken(
  companyId: string,
  chat: { conversationId: string; connectionId?: string; generation?: number },
  job: { jobId: string; issuedAt: string },
): string | undefined {
  try {
    const conversation = uuidBytes(chat.conversationId);
    const connection = chat.connectionId ? uuidBytes(chat.connectionId) : Buffer.alloc(16);
    const issued = Date.parse(job.issuedAt);
    const generation = chat.connectionId ? (chat.generation ?? 0) : 0;
    if (!conversation || !connection || !Number.isFinite(issued)) return undefined;
    if (!Number.isInteger(generation) || generation < 0 || generation > 0xffffffff)
      return undefined;
    const key = derivedKey('menu-link');
    const body = Buffer.alloc(LENGTH - 16);
    body[0] = 1;
    body.writeUInt32BE(Math.floor((issued + MENU_LINK_TTL_MS) / 1000), 1);
    conversation.copy(body, 5);
    connection.copy(body, 21);
    body.writeUInt32BE(generation, 37);
    createHmac('sha256', key).update(`nonce:${job.jobId}`).digest().copy(body, 41, 0, 8);
    return Buffer.concat([body, mac(key, companyId, body)]).toString('base64url');
  } catch {
    return undefined;
  }
}

export function verifyMenuToken(
  companyId: string,
  token: string,
  now = Date.now(),
): MenuTokenCheck {
  try {
    if (!/^[A-Za-z0-9_-]{87}$/.test(token)) return { ok: false, reason: 'invalid' };
    const bytes = Buffer.from(token, 'base64url');
    if (bytes.length !== LENGTH || bytes[0] !== 1) return { ok: false, reason: 'invalid' };
    const body = bytes.subarray(0, LENGTH - 16);
    if (
      !timingSafeEqual(bytes.subarray(LENGTH - 16), mac(derivedKey('menu-link'), companyId, body))
    )
      return { ok: false, reason: 'invalid' };
    const expires = body.readUInt32BE(1) * 1000;
    if (expires > now + MENU_LINK_TTL_MS + SKEW_MS) return { ok: false, reason: 'invalid' };
    if (expires <= now) return { ok: false, reason: 'expired' };
    const connection = body.subarray(21, 37);
    const linked = connection.some((byte) => byte !== 0);
    return {
      ok: true,
      claims: {
        conversationId: uuidText(body.subarray(5, 21)),
        ...(linked && {
          connectionId: uuidText(connection),
          generation: body.readUInt32BE(37),
        }),
        expiresAt: new Date(expires).toISOString(),
        nonce: body.subarray(41, 49).toString('base64url'),
      },
    };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}
