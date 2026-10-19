// FX-8 (frontend-4): the admin's linked-phone switch shows what the server really allows. A
// business that used a linked phone before approvals existed reads 'Allowed (existing linked
// phone)', and unticking it stops new pairings in one step.
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LinkedDeviceSwitch } from '../src/components/People';
import {
  LINKED_DEVICE_NOTES,
  linkedDeviceCopy,
  linkedDeviceOn,
  linkedDeviceRequest,
  linkedDeviceState,
  type LinkedDeviceState,
} from '../src/lib/people';

const source = (file: string) => readFileSync(join(process.cwd(), file), 'utf8');
const render = (state: LinkedDeviceState) =>
  renderToStaticMarkup(
    createElement(LinkedDeviceSwitch, { state, pending: false, onAsk: vi.fn() }),
  );
const checked = (html: string) => /<input[^>]*type="checkbox"[^>]*checked=""/.test(html);

describe('the linked-phone switch on People', () => {
  it('follows the saved choice, and the server’s answer where none was saved', () => {
    expect(linkedDeviceState(true)).toBe('allowed');
    expect(linkedDeviceState(true, false)).toBe('allowed');
    expect(linkedDeviceState(false, true)).toBe('stopped');
    expect(linkedDeviceState(undefined, true)).toBe('existing');
    expect(linkedDeviceState(undefined, false)).toBe('not_allowed');
    expect(linkedDeviceState(undefined)).toBe('unknown');
    expect(['allowed', 'existing'].map((s) => linkedDeviceOn(s as LinkedDeviceState))).toEqual([
      true,
      true,
    ]);
    for (const s of ['stopped', 'not_allowed', 'unknown'] as const)
      expect(linkedDeviceOn(s)).toBe(false);
  });

  it('shows a business allowed only by its existing linked phone as allowed, and says so', () => {
    const html = render('existing');
    expect(checked(html)).toBe(true);
    expect(html).toContain('Allowed (existing linked phone)');
    expect(html).toContain(LINKED_DEVICE_NOTES.existing);
    expect(LINKED_DEVICE_NOTES.existing).toMatch(/until you stop it/);
    expect(LINKED_DEVICE_NOTES.existing).toMatch(/even for another number/);
  });

  it('stops pairing in one step: unticking asks to stop, with the stop wording', () => {
    const page = source('src/components/People.tsx');
    expect(page).toContain('onChange={() => onAsk(!on)}');
    // 'existing' is ticked, so unticking it asks to stop (onAsk(false)), never to allow first.
    expect(linkedDeviceOn('existing')).toBe(true);
    expect(linkedDeviceCopy('Laziza', false).title).toBe('Stop linked-phone pairing for Laziza?');
    expect(linkedDeviceRequest('c1', false).body).toEqual({ allowed: false });
    // Where the connection couldn't be checked, Stop pairing is right there.
    const unknown = render('unknown');
    expect(checked(unknown)).toBe(false);
    expect(unknown).toContain('Stop pairing');
    expect(unknown).toContain('Not decided yet');
    expect(page).toContain('onClick={() => onAsk(false)}');
  });

  it('keeps the allowed and stopped switches as before', () => {
    const allowed = render('allowed');
    expect(checked(allowed)).toBe(true);
    expect(allowed).toContain('Allow linked-phone pairing');
    expect(allowed).not.toContain('Allowed (existing linked phone)');
    expect(allowed).not.toContain('Stop pairing');
    const stopped = render('stopped');
    expect(checked(stopped)).toBe(false);
    expect(stopped).toContain('WhatsApp can ban a number linked this way.');
    expect(stopped).not.toContain('Stop pairing');
  });

  it('asks the server only for businesses without a saved choice', () => {
    const page = source('src/components/People.tsx');
    expect(page).toMatch(
      /linkedDeviceAllowed === undefined\)\s*api<\{ pairingAllowed\?: boolean \}>\('\/whatsapp\/connection', business\.id\)/,
    );
    expect(page).toContain('linkedDeviceCopy(linked.name, linked.allowed)');
  });
});
