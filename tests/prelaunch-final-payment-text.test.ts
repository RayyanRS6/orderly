import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRepository } from '../server/repository';
import { publicMenu } from '../server/menu';
import { paymentSentence, paymentShort, staffPaymentNote } from '../src/lib/payments';
import { seedCompanies } from '../src/shared/seed';
import type { PaymentMethod } from '../src/shared/types';

// Restaurants that take only cash keep every word customers and staff saw before payment
// methods could be chosen. Transfers never show an account number: the restaurant shares it.
describe('payment wording on the menu page and the order card', () => {
  it('keeps the cash-only sentences exactly as they were', () => {
    expect(paymentSentence(['cash'], true)).toBe('Pay cash on delivery.');
    expect(paymentSentence(['cash'], false)).toBe('Pay cash at pickup.');
    expect(paymentShort(['cash'])).toBe('pay in cash');
    expect(staffPaymentNote(['cash'], true)).toBe('cash on delivery');
    expect(staffPaymentNote(['cash'], false)).toBe('cash at pickup');
  });

  it('names the transfers a restaurant takes, and says it shares the details', () => {
    const all: PaymentMethod[] = ['cash', 'jazzcash', 'easypaisa', 'bank_transfer'];
    expect(paymentSentence(all, true)).toBe(
      'Pay cash on delivery, or by JazzCash, Easypaisa or bank transfer. The restaurant will share the payment details.',
    );
    expect(paymentSentence(['jazzcash'], false)).toBe(
      'Pay by JazzCash. The restaurant will share the payment details.',
    );
    expect(paymentShort(all)).toBe('pay in cash or by transfer');
    expect(paymentShort(['easypaisa'])).toBe('pay by transfer');
    expect(staffPaymentNote(all, false)).toBe('cash or transfer at pickup');
    expect(staffPaymentNote(['bank_transfer'], true)).toBe('transfer on delivery');
    for (const text of [paymentSentence(all, true), paymentShort(all)])
      expect(text).not.toMatch(/\d{6,}/);
  });
});

describe('public menu data', () => {
  const company = seedCompanies[0]!;
  let repo: MemoryRepository;
  beforeEach(async () => {
    vi.stubEnv('APP_MODE', 'demo');
    repo = new MemoryRepository();
    await repo.setMenuLink(company.id, true, company.slug);
  });
  afterEach(() => vi.unstubAllEnvs());

  it('sends no payment field for a cash-only restaurant, as before', async () => {
    const menu = await publicMenu(repo, company.slug, new Date().toISOString());
    expect(menu.restaurant).not.toHaveProperty('paymentMethods');
    await repo.saveCompany({ ...(await repo.getCompany(company.id))!, paymentMethods: ['cash'] });
    const again = await publicMenu(repo, company.slug, new Date().toISOString());
    expect(again.restaurant).not.toHaveProperty('paymentMethods');
  });

  it('sends the methods when the restaurant also takes transfers', async () => {
    await repo.saveCompany({
      ...(await repo.getCompany(company.id))!,
      paymentMethods: ['easypaisa', 'cash'],
    });
    const menu = await publicMenu(repo, company.slug, new Date().toISOString());
    expect(menu.restaurant.paymentMethods).toEqual(['cash', 'easypaisa']);
  });
});
