import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { derivedKey, hmacHex, hmacKey22 } from '../server/security';
import { MENU_LINK_TTL_MS, signMenuToken, verifyMenuToken } from '../server/menu-token';
import { clientKey } from '../server/client-key';

const companyId = '11111111-1111-4111-a111-111111111111';
const chat = {
  conversationId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  connectionId: '99999999-8888-4777-a666-555555555555',
  generation: 3,
};
const issuedAt = '2026-10-16T10:00:00.000Z';
const issued = Date.parse(issuedAt);

const credentialKey = Buffer.alloc(32, 7);
beforeEach(() => {
  vi.stubEnv('APP_MODE', 'live');
  vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', credentialKey.toString('base64'));
  vi.stubEnv('MENU_LINK_SECRET', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('derived menu keys', () => {
  it('derives one key per purpose from the credential key when no override is set', () => {
    const expected = createHmac('sha256', credentialKey).update('orderly:menu-link:v1').digest();
    expect(derivedKey('menu-link').equals(expected)).toBe(true);
    expect(derivedKey('menu-draft').equals(expected)).toBe(false);
    expect(derivedKey('client-ip').equals(derivedKey('menu-draft'))).toBe(false);
    expect(hmacHex('menu-draft', 'x')).toMatch(/^[0-9a-f]{64}$/);
    expect(hmacKey22('client-ip', '203.0.113.9')).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(hmacKey22('client-ip', '203.0.113.9')).not.toContain('203');
  });
  it('uses MENU_LINK_SECRET when set, and refuses a short or malformed one', () => {
    const before = derivedKey('menu-link');
    vi.stubEnv('MENU_LINK_SECRET', Buffer.alloc(48, 3).toString('base64'));
    expect(derivedKey('menu-link').equals(before)).toBe(false);
    vi.stubEnv('MENU_LINK_SECRET', Buffer.alloc(16, 3).toString('base64'));
    expect(() => derivedKey('menu-link')).toThrow(
      'MENU_LINK_SECRET must be base64 of at least 32 bytes.',
    );
    vi.stubEnv('MENU_LINK_SECRET', 'not base64 at all!');
    expect(() => derivedKey('menu-draft')).toThrow('MENU_LINK_SECRET');
  });
});

describe('personal menu link tokens', () => {
  it('round-trips the chat, connection, expiry and a fixed nonce', () => {
    const token = signMenuToken(companyId, chat, { jobId: 'job-1', issuedAt })!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{87}$/);
    const checked = verifyMenuToken(companyId, token, issued + 1000);
    expect(checked).toEqual({
      ok: true,
      claims: {
        ...chat,
        expiresAt: new Date(issued + MENU_LINK_TTL_MS).toISOString(),
        nonce: expect.stringMatching(/^[A-Za-z0-9_-]{11}$/),
      },
    });
    const legacy = signMenuToken(
      companyId,
      { conversationId: chat.conversationId },
      { jobId: 'job-1', issuedAt },
    )!;
    const plain = verifyMenuToken(companyId, legacy, issued);
    expect(plain.ok && plain.claims).toEqual({
      conversationId: chat.conversationId,
      expiresAt: new Date(issued + MENU_LINK_TTL_MS).toISOString(),
      nonce: expect.any(String),
    });
  });

  it('gives a retried send job the identical token, and another job a new nonce', () => {
    const first = signMenuToken(companyId, chat, { jobId: 'job-1', issuedAt });
    expect(signMenuToken(companyId, chat, { jobId: 'job-1', issuedAt })).toBe(first);
    const other = signMenuToken(companyId, chat, { jobId: 'job-2', issuedAt })!;
    const nonce = (token: string) => {
      const checked = verifyMenuToken(companyId, token, issued);
      return checked.ok ? checked.claims.nonce : '';
    };
    expect(nonce(other)).not.toBe(nonce(first!));
  });

  it('refuses a changed token, another business and a token too far in the future', () => {
    const token = signMenuToken(companyId, chat, { jobId: 'job-1', issuedAt })!;
    const bytes = Buffer.from(token, 'base64url');
    bytes[10] ^= 1;
    expect(verifyMenuToken(companyId, bytes.toString('base64url'), issued)).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(verifyMenuToken('22222222-2222-4222-a222-222222222222', token, issued)).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(verifyMenuToken(companyId, `${token}A`, issued).ok).toBe(false);
    expect(verifyMenuToken(companyId, 'short', issued).ok).toBe(false);
    // Signed for a job created three hours from now: more than the lifetime plus 5 minutes.
    const later = signMenuToken(companyId, chat, {
      jobId: 'job-1',
      issuedAt: new Date(issued + 3 * 3600000).toISOString(),
    })!;
    expect(verifyMenuToken(companyId, later, issued)).toEqual({ ok: false, reason: 'invalid' });
    const fine = signMenuToken(companyId, chat, {
      jobId: 'job-1',
      issuedAt: new Date(issued + 4 * 60000).toISOString(),
    })!;
    expect(verifyMenuToken(companyId, fine, issued).ok).toBe(true);
  });

  it('expires after two hours', () => {
    const token = signMenuToken(companyId, chat, { jobId: 'job-1', issuedAt })!;
    expect(verifyMenuToken(companyId, token, issued + MENU_LINK_TTL_MS - 1000).ok).toBe(true);
    expect(verifyMenuToken(companyId, token, issued + MENU_LINK_TTL_MS)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('makes no token for an unusual chat id or a broken secret', () => {
    expect(
      signMenuToken(companyId, { conversationId: 'demo-123' }, { jobId: 'j', issuedAt }),
    ).toBeUndefined();
    expect(
      signMenuToken(companyId, { ...chat, connectionId: 'nope' }, { jobId: 'j', issuedAt }),
    ).toBeUndefined();
    vi.stubEnv('MENU_LINK_SECRET', 'too-short');
    expect(signMenuToken(companyId, chat, { jobId: 'j', issuedAt })).toBeUndefined();
    vi.stubEnv('MENU_LINK_SECRET', '');
    const token = signMenuToken(companyId, chat, { jobId: 'j', issuedAt })!;
    vi.stubEnv('MENU_LINK_SECRET', Buffer.alloc(32, 9).toString('base64'));
    expect(verifyMenuToken(companyId, token, issued)).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('visitor rate-limit keys', () => {
  it('hashes the first address header present, and skips visitors without one', () => {
    const key = clientKey(new Headers({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }));
    expect(key).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(clientKey(new Headers({ 'x-real-ip': '203.0.113.9' }))).toBe(key);
    expect(
      clientKey(new Headers({ 'cf-connecting-ip': '198.51.100.7', 'x-real-ip': '203.0.113.9' })),
    ).not.toBe(key);
    expect(clientKey(new Headers())).toBeUndefined();
  });
});
