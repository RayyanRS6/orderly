// FX-5a (3): the WhatsApp connection says plainly what to do about an expired pairing or a full
// linked-phone service, and keeps "remove Orderly under Linked devices" on screen when a switch or
// disconnect could not end the old linked-phone session (gatewayCleanupPending).
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApiError } from '../src/lib/api';
import {
  connectionProblem,
  GATEWAY_PROBLEMS,
  gatewayMessage,
  LINKED_CLEANUP,
  LinkedCleanupNote,
} from '../src/components/WhatsAppConnection';

const source = (file: string) => readFileSync(join(process.cwd(), file), 'utf8');

describe('FX-5a: linked-phone problems in plain words', () => {
  it('says what to do about an expired pairing and a full service', () => {
    expect(connectionProblem('error', 'PAIRING_EXPIRED')).toBe(
      'The pairing code expired. Start pairing again.',
    );
    expect(connectionProblem('error', 'SESSION_CAPACITY_REACHED')).toBe(
      'Orderly’s linked-phone service is full right now. Contact Orderly support.',
    );
    // Every other code reads as before.
    expect(connectionProblem('error', 'SESSION_CRASH')).toBe(
      'Connection needs attention: the connection stopped unexpectedly. Try reconnecting, or start a new pairing if WhatsApp logged this device out.',
    );
    expect(connectionProblem('error', 'DISCONNECT_428')).toMatch(
      /^Connection needs attention: WhatsApp closed the connection \(DISCONNECT_428\)\. Try reconnecting/,
    );
    expect(connectionProblem('reconnecting', 'RECONNECT_EXHAUSTED')).toMatch(
      /reconnecting failed several times\. The gateway is reconnecting to WhatsApp by itself/,
    );
    expect(source('src/components/WhatsAppConnection.tsx')).toContain(
      "{connectionProblem(state, snapshot?.errorCode || connection.errorCode || '')}",
    );
  });

  it('uses the same words when a request fails with one of those codes', () => {
    for (const code of ['PAIRING_EXPIRED', 'SESSION_CAPACITY_REACHED'])
      expect(gatewayMessage(new ApiError('Gateway said no.', 503, { code }), 'x')).toBe(
        GATEWAY_PROBLEMS[code],
      );
    expect(gatewayMessage(new ApiError('Gateway said no.', 503, { code: 'OTHER' }), 'x')).toBe(
      'Gateway said no.',
    );
    expect(gatewayMessage('not an error', 'Connection failed.')).toBe('Connection failed.');
  });

  it('keeps the Linked devices step on screen until it is dismissed', () => {
    const html = renderToStaticMarkup(createElement(LinkedCleanupNote, { onDismiss: () => {} }));
    expect(html).toContain('role="status"');
    expect(html).toContain(LINKED_CLEANUP);
    expect(LINKED_CLEANUP).toContain('remove Orderly under WhatsApp → Linked devices');
    expect(html).toContain('aria-label="Dismiss note"');
    // Switch to Meta and Disconnect on the connection card, and Disconnect on the Meta card.
    const card = source('src/components/WhatsAppConnection.tsx');
    expect(card).toContain('if (result?.gatewayCleanupPending) setCleanup(true);');
    expect(card).toContain(
      '{cleanup && <LinkedCleanupNote onDismiss={() => setCleanup(false)} />}',
    );
    const integrations = source('src/components/Settings.tsx');
    expect(integrations).toMatch(
      /if \(target\.kind === 'whatsapp' && result\?\.gatewayCleanupPending\)\s*setLinkedCleanup\(true\);/,
    );
    expect(integrations).toContain("integration.kind === 'whatsapp' && linkedCleanup && (");
  });
});
