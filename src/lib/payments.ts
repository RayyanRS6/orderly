// Payment methods customers can use (Company.paymentMethods). Orderly never collects or sends
// account numbers: for a transfer the customer asks the restaurant in WhatsApp for its payment
// details, and the restaurant confirms the transfer itself.

import type { PaymentMethod } from '../shared/types';

export type { PaymentMethod };
/** A company's payment methods. Missing or empty means cash only, as before the setting existed. */
export type WithPaymentMethods = { paymentMethods?: PaymentMethod[] };
export const PAYMENT_METHODS: { id: PaymentMethod; label: string }[] = [
  { id: 'cash', label: 'Cash' },
  { id: 'jazzcash', label: 'JazzCash' },
  { id: 'easypaisa', label: 'Easypaisa' },
  { id: 'bank_transfer', label: 'Bank transfer' },
];
export const PAYMENT_METHODS_HINT =
  'Orderly never collects payment details. For transfers, your staff share the details and confirm the payment themselves.';
/** The methods a business offers, in the order above. Missing, empty or unknown: cash. */
export function paymentMethodsOf(company: WithPaymentMethods): PaymentMethod[] {
  const saved = Array.isArray(company.paymentMethods) ? company.paymentMethods : [];
  const known = PAYMENT_METHODS.map((m) => m.id).filter((id) => saved.includes(id));
  return known.length ? known : ['cash'];
}
const TRANSFER_NAMES: Record<Exclude<PaymentMethod, 'cash'>, string> = {
  jazzcash: 'JazzCash',
  easypaisa: 'Easypaisa',
  bank_transfer: 'bank transfer',
};
const orList = (names: string[]) =>
  names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}` : names[0]!;
const transfersOf = (methods: PaymentMethod[]) =>
  methods.filter((m): m is Exclude<PaymentMethod, 'cash'> => m !== 'cash');
// The one thing that reaches a person: the customer writes to the restaurant.
const TRANSFER_ASK = 'ask the restaurant in WhatsApp for the details.';
/**
 * How the customer pays, for the menu page. Cash only keeps the sentence the page always had;
 * for a transfer the customer asks the restaurant for its details in WhatsApp (nothing on the
 * restaurant's side is prompted to send them), so no account number is ever shown.
 */
export function paymentSentence(methods: PaymentMethod[], delivery: boolean): string {
  const cash = `cash ${delivery ? 'on delivery' : 'at pickup'}`;
  const transfers = transfersOf(methods).map((m) => TRANSFER_NAMES[m]);
  if (!transfers.length) return `Pay ${cash}.`;
  const by = `by ${orList(transfers)}`;
  return `Pay ${methods.includes('cash') ? `${cash}, or ${by}` : by} — ${TRANSFER_ASK}`;
}
/** The short form after an order is placed: 'pay in cash' as before, or the transfer choice. */
export function paymentShort(methods: PaymentMethod[]): string {
  if (!transfersOf(methods).length) return 'pay in cash';
  return methods.includes('cash') ? 'pay in cash or by transfer' : 'pay by transfer';
}
/** Said after an order is placed when the restaurant takes transfers; empty for cash only. */
export function transferAsk(methods: PaymentMethod[]): string {
  return transfersOf(methods).length ? `To pay by transfer, ${TRANSFER_ASK}` : '';
}
/** Staff wording next to an order total: 'cash on delivery' as before, or with transfers. */
export function staffPaymentNote(methods: PaymentMethod[], delivery: boolean): string {
  const when = delivery ? 'on delivery' : 'at pickup';
  if (!transfersOf(methods).length) return `cash ${when}`;
  return `${methods.includes('cash') ? 'cash or transfer' : 'transfer'} ${when}`;
}
/** Under the total on a staff order card when the restaurant takes transfers; empty for cash only. */
export function staffTransferNote(methods: PaymentMethod[]): string {
  return transfersOf(methods).length
    ? 'A customer paying by transfer asks you for the payment details in WhatsApp. Check each transfer yourself: Orderly does not see payments.'
    : '';
}
/** The methods after ticking or unticking one, in the order above. The last one stays. */
export function togglePaymentMethod(
  current: PaymentMethod[],
  method: PaymentMethod,
  on: boolean,
): PaymentMethod[] {
  const next = PAYMENT_METHODS.map((m) => m.id).filter((id) =>
    id === method ? on : current.includes(id),
  );
  return next.length ? next : current;
}
