import { server$ } from '@qwik.dev/router';
import { Order } from '~/generated/graphql-shop';
import { srTrackOrder, type SrTrackedOrder } from '~/utils/sellright';

export interface OrderTrackingResult {
  order?: Order;
  error?: string;
  success: boolean;
}

/**
 * Guest order tracking — SellRight REST (`GET /v1/shop/track`, code + email).
 * Maps the REST snapshot onto the Vendure-ish `Order` shape the tracking
 * components were built against so OrderDetails stays untouched.
 *
 * State mapping: SellRight keeps order.state on payment lifecycle
 * (Paid/PendingPayment/Refunded…) while shipment progress lives on
 * fulfillments — the component's switch expects the order to reach
 * Shipped/Delivered, so the latest fulfillment state is folded in.
 */
function toVendureOrder(t: SrTrackedOrder): Order {
  const latestFul = t.fulfillments[0];
  const state =
    latestFul?.state === 'Delivered' ? 'Delivered'
    : latestFul?.state === 'Shipped' ? 'Shipped'
    : t.fulfillments.some(f => f.state === 'Shipped') ? 'PartiallyShipped'
    : t.state === 'Paid' ? 'PaymentSettled'
    : t.state;
  const addr = (t.shippingAddress ?? {}) as Record<string, string | undefined>;
  return {
    id: t.code,
    code: t.code,
    state,
    placedAt: t.placedAt,
    currencyCode: t.currency,
    totalWithTax: t.grandTotal,
    subTotalWithTax: t.subtotal + t.taxTotal,
    shippingWithTax: t.shippingTotal,
    customFields: { isPreOrder: t.lines.some(l => l.isPreOrder) },
    shippingAddress: {
      fullName: addr.fullName,
      streetLine1: addr.streetLine1 ?? addr.line1,
      streetLine2: addr.streetLine2 ?? addr.line2,
      city: addr.city,
      province: addr.province,
      postalCode: addr.postalCode,
      country: addr.country ?? addr.countryCode,
      phoneNumber: addr.phoneNumber ?? addr.phone,
    },
    fulfillments: t.fulfillments.map(f => ({
      state: f.state,
      trackingCode: f.trackingCode,
      method: f.carrier,
      updatedAt: f.updatedAt,
    })),
    lines: t.lines.map((l, i) => ({
      id: `${t.code}-${i}`,
      quantity: l.quantity,
      linePriceWithTax: l.lineTotal,
      unitPriceWithTax: l.unitPrice,
      productVariant: {
        name: l.name,
        sku: l.sku,
        customFields: l.isPreOrder ? { preOrderPrice: l.unitPrice, shipDate: l.shipDate } : {},
      },
    })),
  } as unknown as Order;
}

export const trackOrderServer = server$(async (orderCode: string, email: string): Promise<OrderTrackingResult> => {
  try {
    const tracked = await srTrackOrder(orderCode, email);
    return { success: true, order: toVendureOrder(tracked) };
  } catch (error) {
    const status = (error as { status?: number } | null)?.status;
    if (status === 404) {
      return { success: false, error: 'Order not found for that code + email.' };
    }
    console.error('Order tracking error:', error);
    return {
      success: false,
      error: 'Unable to track order at this time. Please try again later.',
    };
  }
});
