import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApiError } from '../src/lib/api';
import { ItemCard, LinkCheckFailed, MenuPage, OrderingNotice } from '../src/components/MenuPage';
import {
  checkoutProblem,
  loadCart,
  loadDraft,
  menuLoadFailure,
  orderFailure,
  saveCart,
  saveDraft,
  typedPhoneLabel,
  type DraftCode,
} from '../src/lib/menu-cart';
import type { PublicMenu, PublicMenuItem } from '../src/shared/menu';

// The menu page's behaviour when things go wrong. The tests run without a browser, so they
// check the page's helpers and what it renders on the server.

const LINK_ENDED = 'This link has expired. Send “menu” in WhatsApp to get a fresh one.';
const apiError = (status: number, code: string, message = 'Server says no.') =>
  new ApiError(message, status, { error: message, code });

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    get length() {
      return data.size;
    },
    key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (name: string) => data.get(name) ?? null,
    setItem: (name: string, value: string) => void data.set(name, String(value)),
    removeItem: (name: string) => void data.delete(name),
    clear: () => data.clear(),
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
});

const menu: PublicMenu = {
  slug: 'karachi-bites',
  restaurant: {
    name: 'Karachi Bites',
    address: '',
    phone: '',
    timezone: 'Asia/Karachi',
    openingHours: { start: '12:00', end: '23:00', days: [0, 1, 2, 3, 4, 5, 6] },
    deliveryZones: [],
    fulfillment: 'pickup',
    currency: 'PKR',
  },
  categories: [],
  ordering: { open: true, botOn: true, publicOrdering: false, reason: 'no_whatsapp' },
  generatedAt: '2026-10-16T10:00:00.000Z',
};

describe('Place order errors', () => {
  it('shows a wrong number or a changed menu in checkout instead of ending a link', () => {
    const phone = apiError(
      422,
      'invalid',
      'Please enter your WhatsApp number, for example 0300 1234567.',
    );
    expect(orderFailure(phone, 'public')).toEqual({
      kind: 'error',
      message: 'Please enter your WhatsApp number, for example 0300 1234567.',
      reloadMenu: true,
    });
    const zone = apiError(422, 'invalid', 'Choose a delivery area: Gulberg, DHA.');
    expect(orderFailure(zone, 'link')).toMatchObject({
      kind: 'error',
      message: 'Choose a delivery area: Gulberg, DHA.',
    });
  });

  it('ends a personal link only when the server says it ended (HTTP 410)', () => {
    for (const state of ['expired', 'used', 'stale', 'invalid'])
      expect(orderFailure(apiError(410, state, LINK_ENDED), 'link')).toEqual({
        kind: 'link_ended',
      });
    // An Instagram/QR customer never had a link to end.
    expect(orderFailure(apiError(410, 'expired', LINK_ENDED), 'public').kind).toBe('error');
  });

  it('reloads the menu when a dish sold out, was removed or its options changed', () => {
    const unavailable = apiError(
      422,
      'unavailable',
      'An item is unavailable. Remove it or ask staff for help.',
    );
    for (const mode of ['link', 'public'] as const) {
      expect(orderFailure(unavailable, mode)).toEqual({
        kind: 'error',
        message: 'An item is unavailable. Remove it or ask staff for help.',
        reloadMenu: true,
      });
      expect(orderFailure(apiError(422, 'invalid'), mode)).toMatchObject({ reloadMenu: true });
    }
    // Nothing on the menu changed for these.
    expect(orderFailure(apiError(422, 'too_large'), 'link')).toMatchObject({ reloadMenu: false });
    expect(orderFailure(apiError(429, 'rate'), 'public')).toMatchObject({ reloadMenu: false });
    expect(orderFailure(apiError(409, 'busy'), 'link')).toMatchObject({ reloadMenu: false });
  });

  it('keeps the other outcomes as they were', () => {
    expect(orderFailure(apiError(409, 'price_changed', 'Prices changed.'), 'link')).toEqual({
      kind: 'price_changed',
      message: 'Prices changed.',
    });
    for (const code of ['no_whatsapp', 'bot_off', 'closed'])
      expect(orderFailure(apiError(409, code), 'public')).toEqual({ kind: 'stopped' });
    expect(orderFailure(apiError(409, 'staff'), 'link')).toEqual({ kind: 'chat', state: 'staff' });
    expect(orderFailure(apiError(403, 'blocked'), 'link')).toEqual({
      kind: 'chat',
      state: 'blocked',
    });
  });

  it('never shows the browser’s own network error text', () => {
    for (const error of [
      new TypeError('Failed to fetch'),
      new TypeError('Load failed'),
      new DOMException('signal timed out', 'TimeoutError'),
    ]) {
      expect(menuLoadFailure(error)).toEqual({
        message: 'Check your connection and try again.',
        missing: false,
      });
      expect(orderFailure(error, 'public')).toEqual({
        kind: 'error',
        message: 'We couldn’t reach the restaurant. Check your connection and try again.',
        reloadMenu: false,
      });
    }
    expect(menuLoadFailure(apiError(404, 'not_found', 'Not available.'))).toEqual({
      message: 'Not available.',
      missing: true,
    });
    expect(menuLoadFailure(apiError(500, 'error', 'The menu is being updated.'))).toEqual({
      message: 'The menu is being updated.',
      missing: false,
    });
  });
});

describe('typed WhatsApp number', () => {
  const form = {
    mode: 'public' as const,
    name: 'Ali',
    fulfillment: 'pickup' as const,
    zone: '',
    address: '',
    phone: '0300 1234567',
  };

  it('checks the number the way the server does, not by counting digits', () => {
    expect(checkoutProblem(form)).toBeUndefined();
    expect(checkoutProblem({ ...form, phone: '+92 300 1234567' })).toBeUndefined();
    // Ten digits, one short of a Pakistani mobile: the server refuses it, so the page does too.
    expect(checkoutProblem({ ...form, phone: '0300 123456' })).toBe(
      'Please enter your WhatsApp number, for example 0300 1234567.',
    );
    expect(checkoutProblem({ ...form, phone: '0300 12345678' })).toContain('WhatsApp number');
    // A personal link already knows the chat.
    expect(checkoutProblem({ ...form, mode: 'link', phone: '' })).toBeUndefined();
    expect(checkoutProblem({ ...form, name: ' A ' })).toBe('Please add your name.');
    expect(checkoutProblem({ ...form, fulfillment: 'delivery' })).toBe(
      'Please choose your delivery area.',
    );
  });

  it('reads the number back the way the customer knows it', () => {
    expect(typedPhoneLabel('0300 1234567')).toBe('+92 300 1234567');
    expect(typedPhoneLabel('+92 300-1234567')).toBe('+92 300 1234567');
    expect(typedPhoneLabel('0092 300 1234567')).toBe('+92 300 1234567');
    expect(typedPhoneLabel('+44 7911 123456')).toBe('+447911123456');
    expect(typedPhoneLabel('0300 123456')).toBeUndefined();
    expect(typedPhoneLabel('')).toBeUndefined();
  });
});

describe('order code kept across a reload', () => {
  const slug = 'karachi-bites';
  const cart = [{ productId: 'p1', quantity: 2, modifierIds: [], notes: '' }];
  const draft = (minutes: number): DraftCode => ({
    code: 'OM-ABCD-EFGH',
    expiresAt: new Date(Date.now() + minutes * 60_000).toISOString(),
    whatsappUrl: 'https://wa.me/923001112222?text=Hi%21%20Code%3A%20OM-ABCD-EFGH',
  });

  it('restores the code and its cart until the code expires', () => {
    const storage = memoryStorage();
    vi.stubGlobal('sessionStorage', storage);
    const saved = draft(20);
    saveDraft(slug, saved);
    saveCart(slug, cart);
    expect(loadDraft(slug)).toEqual(saved);
    expect(loadCart(slug)).toEqual(cart);

    // 21 minutes later the code has expired: the code and its cart are gone.
    expect(loadDraft(slug, Date.now() + 21 * 60_000)).toBeUndefined();
    expect(storage.data.size).toBe(0);

    saveDraft(slug, draft(20));
    saveDraft(slug);
    expect(loadDraft(slug)).toBeUndefined();
  });

  it('ignores a saved code it did not make', () => {
    const storage = memoryStorage();
    vi.stubGlobal('sessionStorage', storage);
    storage.setItem(
      `orderly.menu.${slug}.draft`,
      JSON.stringify({ ...draft(20), whatsappUrl: 'javascript:alert(1)' }),
    );
    expect(loadDraft(slug)).toBeUndefined();
    storage.setItem(`orderly.menu.${slug}.draft`, '{not json');
    expect(loadDraft(slug)).toBeUndefined();
  });

  it('works when the browser refuses storage', () => {
    const refuse = () => {
      throw new Error('SecurityError');
    };
    vi.stubGlobal('sessionStorage', { getItem: refuse, setItem: refuse, removeItem: refuse });
    expect(() => saveDraft(slug, draft(20))).not.toThrow();
    expect(loadDraft(slug)).toBeUndefined();
  });

  it('opens on the code screen after a reload, with Change order and the cart kept', () => {
    const storage = memoryStorage();
    vi.stubGlobal('sessionStorage', storage);
    const saved = draft(20);
    saveDraft(slug, saved);
    saveCart(slug, cart);
    const html = renderToStaticMarkup(createElement(MenuPage, { slug }));
    expect(html).toContain('Almost done!');
    expect(html).toContain('OM-ABCD-EFGH');
    expect(html).toContain(`href="${saved.whatsappUrl.replaceAll('&', '&amp;')}"`);
    expect(html).toContain('Change order');
    expect(html).not.toContain('Opening the menu…');
    expect(loadCart(slug)).toEqual(cart);
  });

  it('opens on the menu once the code has expired', () => {
    const storage = memoryStorage();
    vi.stubGlobal('sessionStorage', storage);
    saveDraft(slug, draft(-1));
    saveCart(slug, cart);
    const html = renderToStaticMarkup(createElement(MenuPage, { slug }));
    expect(html).toContain('Opening the menu…');
    expect(html).not.toContain('OM-ABCD-EFGH');
    expect(storage.data.size).toBe(0);
  });
});

describe('checkout history entry', () => {
  it('closes checkout through one helper that also drops its Back entry', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/MenuPage.tsx'), 'utf8');
    // Only the Back listener and leaveCheckout close checkout directly.
    expect(source.match(/setCheckout\(false\)/g)).toHaveLength(2);
    const helper = /const leaveCheckout = \(\) => \{([\s\S]*?)\n {2}\};/.exec(source)?.[1] ?? '';
    expect(helper).toContain('setCheckout(false)');
    expect(helper).toContain('history.back()');
    // Placed, drafted, a link ending, ordering stopping and a chat change all leave through it.
    const placeOrder = source.slice(
      source.indexOf('async function placeOrder'),
      source.indexOf('if (placed)'),
    );
    expect(placeOrder.match(/leaveCheckout\(\);/g)).toHaveLength(3);
    expect(placeOrder).toContain('linkEnded();');
    expect(/const linkEnded = [\s\S]*?leaveCheckout\(\);\s*\};/.test(source)).toBe(true);
  });
});

describe('menu page banners', () => {
  it('keeps a personal link that could not be checked and offers Try again', () => {
    const html = renderToStaticMarkup(
      createElement(LinkCheckFailed, { retrying: false, onRetry: () => {} }),
    );
    expect(html).toContain(
      'We couldn’t check your order link. Check your connection and try again.',
    );
    expect(html).toContain('Try again');
    const retrying = renderToStaticMarkup(
      createElement(LinkCheckFailed, { retrying: true, onRetry: () => {} }),
    );
    expect(retrying).toContain('aria-busy="true"');
    expect(retrying).toContain('Checking your link…');

    // A failed check keeps the token: only an ended link (in the check or at Place order)
    // drops it, so the page never quietly turns into the code flow or view-only.
    const source = readFileSync(join(process.cwd(), 'src/components/MenuPage.tsx'), 'utf8');
    const check = source.slice(
      source.indexOf('/session`'),
      source.indexOf('}, [slug, linkAttempt]);'),
    );
    const cleanup = check.indexOf('return () =>');
    const failed = check.slice(check.lastIndexOf('() => {', cleanup), cleanup);
    expect(failed).toContain("setLinkCheck('failed')");
    expect(failed).not.toContain('setToken(');
    expect(source.match(/setToken\(undefined\)/g)).toHaveLength(2);
  });

  it('says why an Instagram/QR visitor cannot order when there is no WhatsApp number', () => {
    const html = renderToStaticMarkup(createElement(OrderingNotice, { menu, hasLink: false }));
    expect(html).toContain(
      'Ordering from this page isn’t available right now. You can still browse the menu.',
    );
    // A personal link orders into its own chat, so it gets no such banner.
    expect(
      renderToStaticMarkup(
        createElement(OrderingNotice, {
          menu,
          hasLink: true,
          session: { state: 'ready' },
        }),
      ),
    ).toBe('');
    expect(
      renderToStaticMarkup(
        createElement(OrderingNotice, {
          menu: { ...menu, ordering: { ...menu.ordering, reason: 'closed' } },
          hasLink: false,
        }),
      ),
    ).toContain('We’re closed right now. We open at 12:00.');
  });
});

describe('dish option picker', () => {
  const item: PublicMenuItem = {
    id: 'p1',
    name: 'Chicken Biryani',
    description: '',
    price: 45000,
    available: true,
    emoji: '🍛',
    variants: [
      { id: 'v1', name: 'Half', price: 45000 },
      { id: 'v2', name: 'Full', price: 80000 },
    ],
    modifiers: [{ id: 'm1', name: 'Raita', price: 8000 }],
  };
  const toggle = (picking: boolean) => {
    const html = renderToStaticMarkup(
      createElement(ItemCard, {
        item,
        ordering: true,
        inCart: 0,
        picking,
        onPick: () => {},
        onAdd: () => {},
      }),
    );
    return /<button[^>]*aria-expanded="(?:true|false)"[^>]*>([\s\S]*?)<\/button>/.exec(html)![1];
  };

  it('shows a close icon on Close, and a plus on Choose', () => {
    const open = toggle(true);
    expect(open).toContain('Close');
    expect(open).toContain('lucide-x');
    expect(open).not.toContain('lucide-plus');
    const closed = toggle(false);
    expect(closed).toContain('Choose');
    expect(closed).toContain('lucide-plus');
  });
});
