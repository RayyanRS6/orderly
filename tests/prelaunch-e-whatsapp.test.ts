import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  connectionAdvice,
  LINKED_RISK_NOTICE_VERSION,
  LINKED_RISK_SUMMARY,
  pairingPollDelay,
  pairingUnavailable,
  pairRequest,
} from '../src/components/WhatsAppConnection';
import { linkedDeviceCopy, linkedDeviceRequest } from '../src/lib/people';
import { LINKED_DEVICE_CONSENT_VERSION } from '../server/whatsapp/connections';

const source = (file: string) => readFileSync(join(process.cwd(), file), 'utf8');

describe('linked-phone pairing', () => {
  it('sends the consent to the notice on this page, only once the risk box is ticked', () => {
    expect(LINKED_RISK_NOTICE_VERSION).toBe(LINKED_DEVICE_CONSENT_VERSION);
    expect(pairRequest('code', '+92 300 1234567', true)).toEqual({
      method: 'code',
      phone: '923001234567',
      riskAccepted: true,
      switchConfirmed: true,
      consent: { version: 'linked-device-risk-2026-10-18', accepted: true },
    });
    expect(pairRequest('qr', '', false)).toEqual({
      method: 'qr',
      riskAccepted: false,
      switchConfirmed: true,
    });
  });

  it('repeats the ban risk in the pairing confirmation', () => {
    expect(LINKED_RISK_SUMMARY).toContain('against WhatsApp’s terms');
    expect(LINKED_RISK_SUMMARY).toContain('ban the whole number');
    expect(source('src/components/WhatsAppConnection.tsx')).toContain(
      "confirm === 'pair' ? `${LINKED_RISK_SUMMARY} ` : ''",
    );
  });

  it('asks for the status every 5 seconds only while pairing or reconnecting', () => {
    for (const status of ['connecting', 'awaiting_pairing', 'reconnecting'] as const)
      expect(pairingPollDelay(status)).toBe(5000);
    for (const status of ['connected', 'error', 'disconnected', 'logged_out'] as const)
      expect(pairingPollDelay(status)).toBeUndefined();
    const page = source('src/components/WhatsAppConnection.tsx');
    // Paused in a background tab, and a 429 waits instead of showing an error every 5 seconds.
    expect(page).toContain('if (document.hidden) {');
    expect(page).toContain('delay = (e.retryAfter ?? STATUS_BACKOFF_S) * 1000;');
    // After Reconnect (or any action) it checks again, even if the saved status did not change.
    expect(page).toContain('setChecks((n) => n + 1);');
  });

  it('explains why pairing is unavailable', () => {
    expect(
      pairingUnavailable({ enabled: false, gatewayEnabled: true, pairingAllowed: false }),
    ).toBe(
      'Linked-phone pairing needs approval from Orderly support for this business. The official WhatsApp Business Platform below is the supported route and needs no approval.',
    );
    expect(
      pairingUnavailable({ enabled: false, gatewayEnabled: false, pairingAllowed: true }),
    ).toMatch(
      /switched off on this Orderly server\. The official WhatsApp Business Platform below is the supported route\./,
    );
    expect(pairingUnavailable({ enabled: false })).toMatch(/approval from Orderly support/);
  });

  it('says what to do about each connection problem', () => {
    expect(connectionAdvice('reconnecting')).toMatch(/reconnecting to WhatsApp by itself/);
    expect(connectionAdvice('connected', 'INBOUND_EVENT_REJECTED')).toMatch(
      /customer message could not be passed to Orderly\. Check the restaurant phone/,
    );
    expect(connectionAdvice('error', 'DISCONNECT_405')).toMatch(
      /platform admin must update the gateway \(GATEWAY_WA_VERSION\)/,
    );
    expect(connectionAdvice('error', 'SESSION_CRASH')).toMatch(/^Try reconnecting/);
    expect(connectionAdvice('connected')).toBeUndefined();
    expect(source('src/components/WhatsAppConnection.tsx')).toContain(
      'turn off the WhatsApp Business app’s greeting and away',
    );
  });

  it('lets the platform admin allow it per business, naming the ban risk first', () => {
    const allow = linkedDeviceCopy('Laziza', true);
    expect(allow.title).toBe('Allow linked-phone pairing for Laziza?');
    expect(allow.description).toMatch(/WhatsApp can ban the whole number/);
    expect(allow.tone).toBe('danger');
    expect(linkedDeviceCopy('Laziza', false).description).toMatch(/already using one keeps it/);
    expect(linkedDeviceRequest('company one', true)).toEqual({
      path: '/admin/businesses/company%20one/linked-device',
      method: 'PUT',
      body: { allowed: true },
      success: 'Linked-phone pairing allowed.',
    });
    expect(linkedDeviceRequest('c1', false).body).toEqual({ allowed: false });
    const people = source('src/components/People.tsx');
    expect(people).toContain('Allow linked-phone pairing');
    expect(people).toContain('linkedDeviceCopy(linked.name, linked.allowed)');
  });
});
