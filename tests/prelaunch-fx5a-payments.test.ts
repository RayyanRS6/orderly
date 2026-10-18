// FX-5a (4): owners choose the payment methods customers can use (Company.paymentMethods: cash,
// JazzCash, Easypaisa, bank transfer; at least one; missing means cash). Orderly never collects
// payment details. Local demo store, no network.
import { describe, expect, it } from 'vitest';
import {
  PAYMENT_METHODS,
  PAYMENT_METHODS_HINT,
  paymentMethodsOf,
  togglePaymentMethod,
  type PaymentMethod,
  type WithPaymentMethods,
} from '../src/lib/payments';
import { draftFrom, Settings, settingsSaveBody } from '../src/components/Settings';
import type { Company } from '../src/shared/types';
import { company, demoApp } from './helpers/demo-app';
import { bootstrap, render } from './prelaunch-e-helpers';

const app = demoApp();
// The shared Company type declares paymentMethods once the backend change is merged.
const withMethods = (paymentMethods?: unknown) =>
  ({ ...company, paymentMethods }) as Company & WithPaymentMethods;
// The payment group of the Settings page, one entry per method: [name, checked, disabled].
function group(html: string) {
  const start = html.indexOf('Payment methods customers can use');
  const part = html.slice(start, html.indexOf('Assistant &amp; menu', start));
  return {
    part,
    methods: [...part.matchAll(/<label[^>]*>(<input[^>]*>)([^<]+)<\/label>/g)].map(
      ([, input, name]) => [name, /checked=""/.test(input!), /disabled=""/.test(input!)],
    ),
  };
}

describe('FX-5a: payment methods customers can use', () => {
  it('reads missing, empty or unknown methods as cash, in a fixed order', () => {
    expect(PAYMENT_METHODS.map((m) => [m.id, m.label])).toEqual([
      ['cash', 'Cash'],
      ['jazzcash', 'JazzCash'],
      ['easypaisa', 'Easypaisa'],
      ['bank_transfer', 'Bank transfer'],
    ]);
    expect(paymentMethodsOf({})).toEqual(['cash']);
    expect(paymentMethodsOf({ paymentMethods: [] })).toEqual(['cash']);
    expect(paymentMethodsOf({ paymentMethods: ['paypal'] as unknown as PaymentMethod[] })).toEqual([
      'cash',
    ]);
    expect(paymentMethodsOf({ paymentMethods: ['bank_transfer', 'jazzcash', 'jazzcash'] })).toEqual(
      ['jazzcash', 'bank_transfer'],
    );
  });

  it('keeps at least one method when one is unticked', () => {
    expect(togglePaymentMethod(['cash'], 'easypaisa', true)).toEqual(['cash', 'easypaisa']);
    expect(togglePaymentMethod(['cash', 'easypaisa'], 'cash', false)).toEqual(['easypaisa']);
    expect(togglePaymentMethod(['easypaisa'], 'easypaisa', false)).toEqual(['easypaisa']);
    expect(togglePaymentMethod(['bank_transfer'], 'cash', true)).toEqual(['cash', 'bank_transfer']);
  });

  it('shows Cash ticked for a business that never chose, and it can’t be unticked alone', () => {
    const html = render(Settings, bootstrap({ company: withMethods() }), 'settings');
    const { part, methods } = group(html);
    expect(methods).toEqual([
      ['Cash', true, true],
      ['JazzCash', false, false],
      ['Easypaisa', false, false],
      ['Bank transfer', false, false],
    ]);
    expect(part).toContain('title="Customers need at least one way to pay."');
    expect(part).toContain(PAYMENT_METHODS_HINT);
    expect(PAYMENT_METHODS_HINT).toBe(
      'Orderly never collects payment details. For transfers, your staff share the details and confirm the payment themselves.',
    );
    expect(html).toMatch(/role="group" aria-labelledby="[^"]+"/);
    expect(html).toContain('Delivery is limited to these areas, with cash payment.');
  });

  it('shows the saved methods, and drops “with cash payment” once transfers are offered', () => {
    const html = render(
      Settings,
      bootstrap({ company: withMethods(['easypaisa', 'cash']) }),
      'settings',
    );
    expect(group(html).methods).toEqual([
      ['Cash', true, false],
      ['JazzCash', false, false],
      ['Easypaisa', true, false],
      ['Bank transfer', false, false],
    ]);
    expect(html).toContain('Delivery is limited to these areas.');
    expect(html).not.toContain('with cash payment');
  });

  it('saves the choice at the top of the company, and adds nothing for a business that never chose', async () => {
    // Untouched, the save is exactly as before: no paymentMethods key at all.
    const untouched = settingsSaveBody(draftFrom(company));
    expect(untouched).not.toHaveProperty('paymentMethods');
    const draft = draftFrom(company) as Company & WithPaymentMethods;
    const chosen = settingsSaveBody({
      ...draft,
      paymentMethods: togglePaymentMethod(paymentMethodsOf(draft), 'jazzcash', true),
    });
    expect(chosen.paymentMethods).toEqual(['cash', 'jazzcash']);
    // The settings save accepts the body (it is the backend's to store and validate).
    await app.repo().saveCompany({ ...company, botEnabled: false });
    const response = await app.request(`/companies/${company.id}`, {
      method: 'PUT',
      body: { ...chosen, botEnabled: false },
    });
    expect(response.status).toBe(200);
  });
});
