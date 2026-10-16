import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { derivedKey, hmacHex, hmacKey22 } from '../server/security';

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
