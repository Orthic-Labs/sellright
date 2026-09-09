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
  customer?: { email: string; firstName: string | null; lastName: string | null };
}): SezzleSessionInput {
  const { order, account, amount, attemptId } = input;
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
      amount <= 0 || amount > order.grandTotal || !input.lines.length) throw new Error('Invalid payment context');
  const complete = new URL('/checkout/confirmation/' + encodeURIComponent(order.code), origin);
  complete.searchParams.set('rt', order.receiptToken);
  complete.searchParams.set('paymentAttempt', attemptId);
  const address = (value: unknown) => {
    const a = (value ?? {}) as Record<string, unknown>;
    return { name: a.fullName, street: a.line1 ?? a.streetLine1, street2: a.line2 ?? a.streetLine2,
      city: a.city, state: a.province, postal_code: a.postalCode, country_code: a.country ?? a.countryCode };
  };
  const items = input.lines.map(line => {
    if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0 ||
        !Number.isSafeInteger(line.unitPrice) || line.unitPrice < 0) throw new Error('Invalid order line');
    return { name: line.variantName, sku: line.variantSku, quantity: line.quantity,
      price: { amount_in_cents: line.unitPrice, currency: order.currency } };
  });
  const subtotal = items.reduce((sum, item) => sum + item.price.amount_in_cents * item.quantity, 0);
  // Inclusive prices already contain tax. Only add the tax not included in the
  // stored line/shipping amounts; never infer this from today's store settings.
  const tax = order.grandTotal - (subtotal - order.discountTotal + order.shippingTotal);
  if (subtotal !== order.subtotal || !Number.isSafeInteger(tax) || (tax < 0 || tax > order.taxTotal)) {
    throw new Error('Order totals do not reconcile');
  }
  return { storeId: account.storeId, gateway: account, attemptId, orderCode: order.code,
    amount, currency: order.currency, completeUrl: complete.href, cancelUrl: new URL('/checkout', origin).href,
    customer: { email, first_name: input.customer?.firstName, last_name: input.customer?.lastName,
      shipping_address: address(order.shippingAddress), billing_address: address(order.billingAddress ?? order.shippingAddress) },
    items, shipping: order.shippingTotal, tax,
    discount: order.discountTotal + order.grandTotal - amount };
}
