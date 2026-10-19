// FX-8 (gateway-1, api-security-6, docs-privacy-8): only a new pairing needs the admin's
// approval. A linked phone already in use keeps Reconnect, Disconnect and its status checks when
// the approval is withdrawn or was never recorded, and the page never tells the owner to start a
// pairing they can't start.
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApiError } from '../src/lib/api';
import {
  connectionAdvice,
  connectionProblem,
  gatewayMessage,
  GATEWAY_PROBLEMS,
  LinkedPhoneActions,
  linkedControls,
  PAIRING_ENDED,
  type PairingAccess,
} from '../src/components/WhatsAppConnection';

const source = (file: string) => readFileSync(join(process.cwd(), file), 'utf8');
const linked = { provider: 'baileys' as const };
const meta = { provider: 'meta' as const };
// What GET /whatsapp/connection sends for a business whose approval was withdrawn, or that
// paired before approvals and whose phone then failed.
const notApproved: PairingAccess = { enabled: false, gatewayEnabled: true, pairingAllowed: false };

const actions = (
  access: PairingAccess,
  connection: typeof linked | typeof meta | null,
  state: Parameters<typeof LinkedPhoneActions>[0]['state'] = 'connected',
) =>
  renderToStaticMarkup(
    createElement(LinkedPhoneActions, {
      controls: linkedControls(access, connection),
      state,
      startDisabled: false,
      onStart: () => {},
      onReconnect: () => {},
      onDisconnect: () => {},
    }),
  );

describe('an existing linked phone without pairing approval', () => {
  it('keeps Reconnect, Disconnect and status checks when the approval was withdrawn', () => {
    expect(linkedControls(notApproved, linked)).toEqual({
      pair: false,
      reconnect: true,
      disconnect: true,
      poll: true,
    });
    const html = actions(notApproved, linked, 'connected');
    expect(html).toContain('Reconnect');
    expect(html).toContain('Disconnect');
    expect(html).not.toContain('Start new pairing');
  });

  it('keeps them for a business from before approvals whose phone is in error', () => {
    const html = actions(notApproved, linked, 'error');
    expect(html).toContain('Reconnect');
    expect(html).toContain('Disconnect');
    expect(html).not.toContain('Start new pairing');
    // An ended session can't be reconnected, and no pairing is suggested.
    const ended = actions(notApproved, linked, 'logged_out');
    expect(ended).toContain('title="This session ended."');
    expect(ended).toContain('disabled=""');
    expect(ended).not.toMatch(/new pairing/);
  });

  it('still shows every control to an approved business, as before', () => {
    const approved: PairingAccess = { enabled: true, gatewayEnabled: true, pairingAllowed: true };
    const html = actions(approved, linked);
    expect(html).toContain('Start new pairing');
    expect(html).toContain('Reconnect');
    expect(html).toContain('Disconnect');
    expect(actions(approved, linked, 'disconnected')).toContain(
      'This session ended. Start a new pairing instead.',
    );
    // Not linked yet: only the pairing button.
    const fresh = actions(approved, null);
    expect(fresh).toContain('Start new pairing');
    expect(fresh).not.toContain('Disconnect');
    // On the official route without approval: no linked-phone buttons at all.
    expect(actions(notApproved, meta)).toBe('');
  });

  it('follows the server’s flags, and works with servers that send fewer', () => {
    // A server that says the existing phone can be managed (or not).
    expect(linkedControls({ ...notApproved, manageable: false }, linked)).toMatchObject({
      reconnect: false,
      disconnect: true,
      poll: false,
    });
    expect(
      linkedControls({ enabled: false, gatewayEnabled: false, manageable: true }, linked),
    ).toMatchObject({ reconnect: true, poll: true });
    // The gateway is switched off: the phone can still be disconnected (saved first).
    expect(linkedControls({ enabled: false, gatewayEnabled: false }, linked)).toEqual({
      pair: false,
      reconnect: false,
      disconnect: true,
      poll: false,
    });
    // A server older than the approval sends only `enabled`.
    expect(linkedControls({ enabled: true }, linked)).toEqual({
      pair: true,
      reconnect: true,
      disconnect: true,
      poll: true,
    });
    // Still loading.
    expect(linkedControls(undefined, null)).toEqual({
      pair: false,
      reconnect: false,
      disconnect: false,
      poll: false,
    });
  });

  it('checks the status of an existing linked phone whatever the approval', () => {
    const page = source('src/components/WhatsAppConnection.tsx');
    expect(page).toContain('const controls = linkedControls(access, connection);');
    expect(page).toMatch(/if \(\s*!controls\.poll \|\|\s*connection\?\.provider !== 'baileys'/);
    expect(page).not.toMatch(/if \(\s*!enabled \|\|\s*connection\?\.provider !== 'baileys'/);
    // The buttons are no longer inside the block shown only with pairing allowed.
    expect(page).toMatch(/<\/label>\s*<\/>\s*\)\}\s*\{\/\*[^*]*\*\/\}\s*<LinkedPhoneActions/);
  });
});

describe('a pairing that ended where no new one can start', () => {
  it('says so instead of “Start pairing again”', () => {
    expect(connectionProblem('error', 'PAIRING_EXPIRED', false)).toBe(PAIRING_ENDED);
    expect(PAIRING_ENDED).toMatch(/^This pairing ended before it finished\./);
    expect(PAIRING_ENDED).toMatch(/contact Orderly support/);
    expect(PAIRING_ENDED).not.toMatch(/Start pairing again/);
    expect(gatewayMessage(new ApiError('x', 503, { code: 'PAIRING_EXPIRED' }), 'y', false)).toBe(
      PAIRING_ENDED,
    );
    // Where pairing is allowed, the words are as before.
    expect(connectionProblem('error', 'PAIRING_EXPIRED')).toBe(
      'The pairing code expired. Start pairing again.',
    );
    expect(connectionProblem('error', 'PAIRING_EXPIRED', true)).toBe(
      GATEWAY_PROBLEMS.PAIRING_EXPIRED,
    );
  });

  it('never advises starting a new pairing there', () => {
    for (const code of ['SESSION_CRASH', 'DISCONNECT_428', 'LOGGED_OUT', 'DISCONNECT_405']) {
      const text = connectionProblem('error', code, false);
      expect(text, code).not.toMatch(/start a new pairing|Start pairing/i);
      expect(text, code).toMatch(/Orderly support/);
    }
    expect(connectionAdvice('error', 'SESSION_CRASH', false)).toBe(
      'Try reconnecting. If WhatsApp logged this device out, contact Orderly support to pair it again.',
    );
    // Unchanged where pairing is allowed.
    expect(connectionAdvice('error', 'SESSION_CRASH')).toBe(
      'Try reconnecting, or start a new pairing if WhatsApp logged this device out.',
    );
    expect(connectionAdvice('error', 'DISCONNECT_405')).toMatch(/; then start a new pairing\.$/);
    const page = source('src/components/WhatsAppConnection.tsx');
    expect(page).toContain(
      "{connectionProblem(state, snapshot?.errorCode || connection.errorCode || '', false)}",
    );
  });
});

describe('status checks that keep failing', () => {
  it('stop on 409 and slow to once a minute after repeated errors', () => {
    const page = source('src/components/WhatsAppConnection.tsx');
    expect(page).toMatch(
      /e instanceof ApiError && e\.status === 409\s*\?\s*undefined\s*:\s*failures >= 3 && pairingPollDelay\(status\)\s*\?\s*STATUS_BACKOFF_S \* 1000\s*:\s*pairingPollDelay\(status\)/,
    );
    expect(page).toContain('failures = 0;');
  });
});
