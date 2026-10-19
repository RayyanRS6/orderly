// Payment methods: a restaurant may also take JazzCash, Easypaisa or bank transfers. Cash only,
// the default, keeps every word customers were told before; with transfers the customer is told
// the restaurant shares its payment details and confirms the transfer itself. Orderly never
// collects or sends account numbers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRepository } from '../server/repository';
import { buildAgentFlow } from '../server/agent-flow';
import { createConversation, orderReceivedText, processTurn } from '../src/domain/engine';
import { buildWebOrder } from '../src/domain/web-order';
import { cashOnly, paymentMethods } from '../src/shared/bot';
import { seedCompanies, seedProducts } from '../src/shared/seed';
import { LegalPage } from '../src/components/Legal';
import type { BotAction, Company, Conversation, Order, PaymentMethod } from '../src/shared/types';

// Wednesday 9 September 2026, 18:30 in Karachi (the demo restaurant is open all day).
const now = '2026-09-09T13:30:00.000Z';
const company = seedCompanies[0]!;
const products = seedProducts.filter((p) => p.companyId === company.id);
const biryani = products.find((p) => p.name === 'Chicken Biryani')!;
const taking = (methods?: PaymentMethod[]): Company => ({
  ...company,
  ...(methods && { paymentMethods: methods }),
});
const ALL: PaymentMethod[] = ['cash', 'jazzcash', 'easypaisa', 'bank_transfer'];
const ENGLISH_TRANSFER =
  'to pay by transfer, type “staff” here and restaurant staff will send the payment details and confirm the transfer themselves.';

let message = 0;
function placeOrder(restaurant: Company, fulfillment: 'pickup' | 'delivery' = 'pickup') {
  let c: Conversation = createConversation(company.id, '923000000555', 'demo', now);
  const step = (action: BotAction) => {
    const result = processTurn(restaurant, products, c, {
      messageId: `fx5b-payment-${++message}`,
      text: action.type === 'confirm' ? 'confirm' : 'step',
      action,
      now,
    });
    c = result.conversation;
    return result;
  };
  step({ type: 'add_item', productId: biryani.id, quantity: 2 });
  step({
    type: 'set_details',
    customerName: 'Ali',
    fulfillment,
    ...(fulfillment === 'delivery' && { zone: 'Gulberg', address: '12 Main Boulevard, Gulberg' }),
  });
  step({ type: 'review' });
  const placed = step({ type: 'confirm' });
  expect(placed.order).toBeDefined();
  return placed as typeof placed & { order: Order };
}

describe('payment methods setting', () => {
  it('means cash only when missing, empty or holding unknown values', () => {
    expect(paymentMethods(company)).toEqual(['cash']);
    expect(paymentMethods({ paymentMethods: [] })).toEqual(['cash']);
    expect(paymentMethods({ paymentMethods: ['upi' as PaymentMethod] })).toEqual(['cash']);
    // Never a stored value of the wrong shape: "jazzcash" as text is not a list.
    expect(paymentMethods({ paymentMethods: 'jazzcash' as unknown as PaymentMethod[] })).toEqual([
      'cash',
    ]);
    expect(cashOnly({ paymentMethods: ['cash'] })).toBe(true);
    // Always in the same order, whatever order the owner ticked them in.
    expect(paymentMethods({ paymentMethods: ['bank_transfer', 'cash', 'jazzcash'] })).toEqual([
      'cash',
      'jazzcash',
      'bank_transfer',
    ]);
    expect(cashOnly({ paymentMethods: ['easypaisa'] })).toBe(false);
  });
});

describe('the order confirmation’s payment line', () => {
  it('stays exactly as before for a cash-only restaurant, set or not', () => {
    for (const restaurant of [taking(), taking([]), taking(['cash'])]) {
      const pickup = placeOrder(restaurant);
      expect(pickup.reply).toBe(
        `Order ${pickup.order.reference} received — Rs. 900. Awaiting restaurant acceptance. Payment is cash at pickup.`,
      );
      const delivery = placeOrder(restaurant, 'delivery');
      expect(delivery.reply).toBe(
        `Order ${delivery.order.reference} received — Rs. 1,050. Awaiting restaurant acceptance. Payment is cash on delivery.`,
      );
    }
    const { order } = placeOrder(taking());
    expect(orderReceivedText('ur', order, ['cash'])).toBe(
      `آرڈر ${order.reference} موصول ہوا — Rs. 900۔ ریسٹورنٹ کی منظوری کا انتظار ہے۔ ادائیگی نقد ہوگی۔`,
    );
    expect(orderReceivedText('roman-ur', order, [])).toBe(
      `Order ${order.reference} receive ho gaya — Rs. 900. Restaurant ki manzoori ka intezar hai. Payment cash hogi.`,
    );
  });

  it('names the transfers and says the restaurant shares the details and confirms them', () => {
    const pickup = placeOrder(taking(ALL));
    expect(pickup.reply).toBe(
      `Order ${pickup.order.reference} received — Rs. 900. Awaiting restaurant acceptance. Payment: cash at pickup, or JazzCash / Easypaisa / bank transfer — ${ENGLISH_TRANSFER}`,
    );
    const delivery = placeOrder(taking(['bank_transfer', 'cash']), 'delivery');
    expect(delivery.reply).toBe(
      `Order ${delivery.order.reference} received — Rs. 1,050. Awaiting restaurant acceptance. Payment: cash on delivery, or bank transfer — ${ENGLISH_TRANSFER}`,
    );
    // Without cash, only the transfers.
    const transfersOnly = placeOrder(taking(['easypaisa', 'jazzcash']));
    expect(transfersOnly.reply).toBe(
      `Order ${transfersOnly.order.reference} received — Rs. 900. Awaiting restaurant acceptance. Payment: JazzCash / Easypaisa — ${ENGLISH_TRANSFER}`,
    );
  });

  it('says the same in Urdu and Roman Urdu', () => {
    const { order } = placeOrder(taking());
    expect(orderReceivedText('ur', order, ALL)).toBe(
      `آرڈر ${order.reference} موصول ہوا — Rs. 900۔ ریسٹورنٹ کی منظوری کا انتظار ہے۔ ادائیگی نقد، جاز کیش، ایزی پیسہ یا بینک ٹرانسفر سے ہو سکتی ہے۔ ٹرانسفر کے لیے ریسٹورنٹ کی ادائیگی کی تفصیل یہاں “عملہ” لکھ کر منگوائیں، عملہ ٹرانسفر کی تصدیق خود کرے گا۔`,
    );
    expect(orderReceivedText('ur', order, ['jazzcash'])).toContain(
      'ادائیگی جاز کیش سے ہوگی۔ ٹرانسفر کے لیے ریسٹورنٹ',
    );
    expect(orderReceivedText('roman-ur', order, ['cash', 'easypaisa'])).toBe(
      `Order ${order.reference} receive ho gaya — Rs. 900. Restaurant ki manzoori ka intezar hai. Payment cash ya Easypaisa se ho sakti hai. Transfer ke liye yahan “staff” likhein, restaurant ka staff payment details bhejega aur transfer khud confirm karega.`,
    );
    expect(orderReceivedText('roman-ur', order, ['jazzcash', 'bank_transfer'])).toContain(
      'Payment JazzCash ya bank transfer se hogi.',
    );
    // The phone-confirmation line still follows.
    expect(
      orderReceivedText('en', { ...order, phoneConfirmationRequired: true }, ALL).split('\n')[1],
    ).toBe('Restaurant staff will call to confirm before accepting your order.');
  });

  it('is the same in the WhatsApp confirmation of a menu-page order', () => {
    const chat = createConversation(company.id, '923000000556', 'whatsapp', now);
    const web = { items: [{ productId: biryani.id, quantity: 2, modifierIds: [], notes: '' }] };
    const cart = { ...web, fulfillment: 'pickup' as const, customerName: 'Ali' };
    const options = { now, submissionKey: `${company.id}:${chat.id}:fx5b` };
    const cash = buildWebOrder(taking(), products, chat, cart, options);
    expect(cash.reply.split('\n').at(-1)).toBe(
      `Order ${cash.order.reference} received — Rs. 900. Awaiting restaurant acceptance. Payment is cash at pickup.`,
    );
    const transfers = buildWebOrder(taking(ALL), products, chat, cart, options);
    expect(transfers.reply.split('\n').at(-1)).toBe(
      `Order ${transfers.order.reference} received — Rs. 900. Awaiting restaurant acceptance. Payment: cash at pickup, or JazzCash / Easypaisa / bank transfer — ${ENGLISH_TRANSFER}`,
    );
  });
});

describe('what owners and the privacy policy are told', () => {
  let repo: MemoryRepository;
  beforeEach(() => {
    repo = new MemoryRepository();
    vi.stubEnv('APP_MODE', 'demo');
    vi.stubEnv('ORDERLY_RUNTIME', '');
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('MODEL_PRICING_JSON', '');
    vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  const fixedRules = async (restaurant: Company) =>
    (await buildAgentFlow(repo, restaurant, 'owner')).nodes.find((n) => n.id === 'knowledge')!
      .fixed ?? [];

  it('lists the payment options on the Agent flow page', async () => {
    expect(await fixedRules(taking())).toContain('Payment options are cash on pickup or delivery.');
    expect(await fixedRules(taking(['cash', 'jazzcash', 'bank_transfer']))).toContain(
      'Payment options are cash on pickup or delivery, or JazzCash / bank transfer. To pay by transfer the customer types “staff” in the chat, and restaurant staff send the payment details and confirm the transfer themselves; Orderly never sends account numbers.',
    );
    expect(await fixedRules(taking(['easypaisa']))).toContain(
      'Payment options are Easypaisa. To pay by transfer the customer types “staff” in the chat, and restaurant staff send the payment details and confirm the transfer themselves; Orderly never sends account numbers.',
    );
  });

  it('says a transfer appears in the order confirmation and is checked by the restaurant', () => {
    const privacy = renderToStaticMarkup(createElement(LegalPage, { kind: 'privacy' }))
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ');
    expect(privacy).toContain(
      'A JazzCash, Easypaisa or bank transfer is possible only if the restaurant offers it: the order confirmation then says so, the restaurant gives you its payment details itself, and restaurant staff check the transfer themselves outside Orderly.',
    );
    expect(privacy).not.toContain('which is what the order confirmation and the menu page say');
  });
});
