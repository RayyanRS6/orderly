// Payment methods customers can use (Company.paymentMethods). Orderly never collects or sends
// account numbers: for a transfer the customer is told the restaurant shares the payment
// details and confirms the transfer itself.

export type PaymentMethod = 'cash' | 'jazzcash' | 'easypaisa' | 'bank_transfer';
/**
 * A company's payment methods, typed here until the shared Company type declares
 * `paymentMethods`. Missing or empty means cash only, as before the setting existed.
 */
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
