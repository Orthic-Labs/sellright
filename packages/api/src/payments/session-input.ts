import type { SezzleSessionInput } from './sezzle.js';
import type { GatewayAccount } from './gateway-account.js';

type Snapshot = {
  code: string; receiptToken: string | null; currency: string;
  grandTotal: number; subtotal: number; discountTotal: number; shippingTotal: number; taxTotal: number;
  metadata: unknown; shippingAddress: unknown; billingAddress: unknown;
};
type Line = { variantName: string; variantSku: string; quantity: number; unitPrice: number };

/** Validate everything local before recording an attempt that can move money. */
export function prepareSezzleSession(input: {
  order: Snapshot; lines: Line[]; account: GatewayAccount; amount: number;
  attemptId: string; storefrontUrl?: string;
  /** Order-edit balance payment: Sezzle returns to the pay page, not checkout. */
  balance?: boolean;
  /** Order-edit adjustments (untaxed +/- cents, already inside grandTotal). */
  adjustments?: Array<{ label: string; amount: number }>;
  customer?: { email: string; firstName: string | null; lastName: string | null };
}): SezzleSessionInput {
  const { order, account, amount, attemptId } = input;
  // Order editing keeps removed lines at quantity 0 as history; they are not
  // part of what the customer is buying now.
  const lines = input.lines.filter(line => line.quantity !== 0);
  const adjustments = input.adjustments ?? [];
  if (adjustments.some(a => !Number.isSafeInteger(a.amount))) throw new Error('Invalid order adjustment');
  const adjustmentTotal = adjustments.reduce((n, a) => n + a.amount, 0);
  if (!input.storefrontUrl) throw new Error('Storefront URL required');
  const origin = new URL(input.storefrontUrl);
  const localTest = account.mode === 'test' && origin.protocol === 'http:' &&
    ['localhost', '127.0.0.1'].includes(origin.hostname);
  if ((origin.protocol !== 'https:' && !localTest) || origin.username || origin.password) {
    throw new Error('Invalid storefront URL');
  }
  const metadata = order.metadata as { contact?: { email?: string } } | null;
  const email = metadata?.contact?.email || input.customer?.email;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Customer email required');
  if (!order.receiptToken || order.currency !== 'USD' || !Number.isSafeInteger(amount) ||
      amount <= 0 || amount > order.grandTotal) throw new Error('Invalid payment context');
  const balance = input.balance === true;
  const complete = new URL((balance ? '/orders/' : '/checkout/confirmation/') + encodeURIComponent(order.code), origin);
  complete.searchParams.set('rt', order.receiptToken);
  if (balance) complete.searchParams.set('pay', 'balance');
  complete.searchParams.set('paymentAttempt', attemptId);
  const address = (value: unknown) => {
    const a = (value ?? {}) as Record<string, unknown>;
    return { name: a.fullName, street: a.line1 ?? a.streetLine1, street2: a.line2 ?? a.streetLine2,
      city: a.city, state: a.province, postal_code: a.postalCode, country_code: a.country ?? a.countryCode };
  };
  const lineItems = lines.map(line => {
    if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0 ||
        !Number.isSafeInteger(line.unitPrice) || line.unitPrice < 0) throw new Error('Invalid order line');
    return { name: line.variantName, sku: line.variantSku, quantity: line.quantity,
      price: { amount_in_cents: line.unitPrice, currency: order.currency } };
  });
  const subtotal = lineItems.reduce((sum, item) => sum + item.price.amount_in_cents * item.quantity, 0);
  // Inclusive prices already contain tax. Only add the tax not included in the
  // stored line/shipping amounts; never infer this from today's store settings.
  const tax = order.grandTotal - (subtotal - order.discountTotal + order.shippingTotal + adjustmentTotal);
  if (subtotal !== order.subtotal || !Number.isSafeInteger(tax) || (tax < 0 || tax > order.taxTotal)) {
    throw new Error('Order totals do not reconcile');
  }
  // Positive adjustments are charges (extra items); negative ones are credits
  // (folded into the discount) — together they net to adjustmentTotal, so the
  // session total still equals the balance being charged.
  const items = [...lineItems, ...adjustments.filter(a => a.amount > 0).map(a => ({
    name: a.label, sku: 'adjustment', quantity: 1, price: { amount_in_cents: a.amount, currency: order.currency } }))];
  if (!items.length) throw new Error('Invalid payment context');
  const credits = adjustments.filter(a => a.amount < 0).reduce((n, a) => n - a.amount, 0);
  return { storeId: account.storeId, gateway: account, attemptId, orderCode: order.code,
    amount, currency: order.currency, completeUrl: complete.href,
    cancelUrl: balance ? (() => { const u = new URL('/orders/' + encodeURIComponent(order.code), origin);
      u.searchParams.set('rt', order.receiptToken!); u.searchParams.set('pay', 'balance'); return u.href; })()
      : new URL('/checkout', origin).href,
    ...(balance ? { description: `Order ${order.code} balance`, discountLabel: 'Previously paid' } : {}),
    customer: { email, first_name: input.customer?.firstName, last_name: input.customer?.lastName,
      shipping_address: address(order.shippingAddress), billing_address: address(order.billingAddress ?? order.shippingAddress) },
    items, shipping: order.shippingTotal, tax,
    discount: order.discountTotal + credits + order.grandTotal - amount };
}
