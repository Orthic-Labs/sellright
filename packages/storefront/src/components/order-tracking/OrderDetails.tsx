import { component$ } from '@qwik.dev/core';
import { Order } from '~/generated/graphql-shop';
import { formatPrice, formatDateTime } from '~/utils';
import { OptimizedImage } from '~/components/ui';

interface OrderDetailsProps {
  order: Order;
}

export const OrderDetails = component$<OrderDetailsProps>(({ order }) => {
  // Helper function to check if order contains pre-order items
  const hasPreOrderItems = (order: any) => {
    if (!order?.lines) return false;
    return order.lines.some((line: any) =>
      line.productVariant?.customFields?.preOrderPrice
    );
  };

  // Helper function to get the latest ship date from pre-order items
  const getLatestPreOrderShipDate = (order: any) => {
    if (!order?.lines) return null;

    const preOrderDates = order.lines
      .filter((line: any) => line.productVariant?.customFields?.preOrderPrice)
      .map((line: any) => line.productVariant?.customFields?.shipDate)
      .filter((date: any) => date) // Remove null/undefined dates
      .map((date: any) => new Date(date))
      .filter((date: Date) => !isNaN(date.getTime())); // Remove invalid dates

    if (preOrderDates.length === 0) return null;

    // Return the latest (farthest) date
    const timestamps = preOrderDates.map((date: Date) => date.getTime());
    const latestTimestamp = Math.max(...timestamps);
    const latestDate = new Date(latestTimestamp);
    return latestDate;
  };

  // Helper function to format ship date for display
  const formatShipDate = (date: Date) => {
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  };

  // Get tracking information from fulfillments
  const getTrackingInfo = () => {
    if (!order.fulfillments || order.fulfillments.length === 0) {
      return { hasTracking: false };
    }

    const fulfillmentWithTracking = order.fulfillments.find(f => f.trackingCode);
    if (fulfillmentWithTracking) {
      return {
        hasTracking: true,
        trackingCode: fulfillmentWithTracking.trackingCode,
        carrier: fulfillmentWithTracking.method || 'Standard Shipping',
        status: fulfillmentWithTracking.state,
        shipDate: fulfillmentWithTracking.updatedAt,
      };
    }

    return { hasTracking: false };
  };

  const trackingInfo = getTrackingInfo();

  // Get order status display info
  const getOrderStatus = () => {
    switch (order.state) {
      case 'PaymentSettled': {
        if ((order.customFields as any)?.isPreOrder) {
          const latestShipDate = getLatestPreOrderShipDate(order);
          const description = latestShipDate
            ? `Expected to ship around ${formatShipDate(latestShipDate)}`
            : 'Expected ship date to be announced';
          return {
            status: 'Pre-ordered',
            description,
            color: 'text-[#141210]',
            bgColor: 'bg-[#F5F0E8]',
            icon: '🎯'
          };
        }
        return {
          status: 'Processing',
          description: 'Your payment has been processed and your order is being prepared.',
          color: 'text-[#141210]',
          bgColor: 'bg-[#F5F0E8]',
          icon: '💳'
        };
      }
      case 'Refunded':
        return {
          status: 'Refunded',
          description: 'Your order has been refunded.',
          color: 'text-[#141210]',
          bgColor: 'bg-[#F5F0E8]',
          icon: '↩️'
        };
      case 'PartiallyShipped':
        return {
          status: 'Partially Shipped',
          description: 'Some items from your order have been shipped.',
          color: 'text-[#141210]',
          bgColor: 'bg-[#F5F0E8]',
          icon: '📦'
        };
      case 'Shipped':
        return {
          status: 'Shipped',
          description: 'Your order has been shipped and is on its way.',
          color: 'text-[#141210]',
          bgColor: 'bg-[#F5F0E8]',
          icon: '🚛'
        };
      case 'Delivered':
        return {
          status: 'Delivered',
          description: 'Your order has been delivered.',
          color: 'text-[#141210]',
          bgColor: 'bg-[#F5F0E8]',
          icon: '✅'
        };
      case 'Cancelled':
        return {
          status: 'Cancelled',
          description: 'This order has been cancelled.',
          color: 'text-[#141210]',
          bgColor: 'bg-[#F5F0E8]',
          icon: '❌'
        };
      default:
        return {
          status: order.state.replace(/([A-Z])/g, ' $1').trim(),
          description: 'Your order is being processed.',
          color: 'text-[#141210]',
          bgColor: 'bg-[#F5F0E8]',
          icon: '⏳'
        };
    }
  };

  const orderStatus = getOrderStatus();

  const getTrackingUrl = (trackingCode: string) => `https://tools.usps.com/go/TrackConfirmAction?qtc_tLabels1=${trackingCode}`;
  const getMaskedTrackingCode = (trackingCode: string) => {
    const normalized = trackingCode.trim();
    const suffix = normalized.slice(-8);
    return `...${suffix}`;
  };

  return (
    <div class="space-y-8">
      {/* Order Header - Compact with total in header */}
      <div class="flex flex-col sm:flex-row sm:items-start sm:justify-between pb-4 border-b border-[#E5E0D8] gap-3">
        <div class="flex flex-col gap-1">
          <h2 class="text-3xl font-heading font-normal text-[#141210]">Order #{order.code}</h2>
          {/* Order Status moved to center-left */}
          <div class="mt-2">
            <div class={`inline-flex items-center gap-2 px-3 py-1.5 ${orderStatus.bgColor} rounded-[3px] text-sm font-medium ${orderStatus.color}`}>
              <div class="text-lg">{orderStatus.icon}</div>
              <div>
                <div class="font-semibold">{orderStatus.status}</div>
                <div class="text-xs mt-0.5 opacity-90">{orderStatus.description}</div>
              </div>
            </div>
          </div>
        </div>
        {/* Order Total moved to top right */}
        <div class="text-right">
          <div class="text-sm font-medium text-[#645541]">Order Total</div>
          <p class="text-2xl font-bold text-[#141210]">
            {formatPrice(order.totalWithTax, order.currencyCode)}
          </p>
          <p class="text-sm text-[#7A7166]">
            {order.lines.length} item{order.lines.length !== 1 ? 's' : ''}
          </p>
        </div>
      </div>

      {/* Tracking Notice for Pre-orders (when no tracking available yet) */}
      {!trackingInfo.hasTracking && hasPreOrderItems(order) && (
        <div class="bg-[#F7F2EA] border border-[#E5E0D8] rounded-[3px] p-6">
          <h3 class="text-lg font-medium text-[#141210] mb-4 flex items-center gap-2">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Pre-order Shipping Notice
          </h3>
          {(() => {
            const latestShipDate = getLatestPreOrderShipDate(order);
            return latestShipDate ? (
              <div class="text-[#645541]">
                <span class="font-medium">Expected ship date: </span>
                <span>{formatShipDate(latestShipDate)}</span>
                <p class="text-sm text-[#7A7166] mt-2">Tracking information will be provided once your pre-order ships.</p>
              </div>
            ) : (
              <div class="text-[#645541]">
                <p class="font-medium">Expected ship date to be announced</p>
                <p class="text-sm text-[#7A7166] mt-2">We'll notify you with tracking information once your pre-order ships.</p>
              </div>
            );
          })()}
        </div>
      )}

      {/* Standard Tracking Notice for regular orders (when no tracking available yet) */}
      {!trackingInfo.hasTracking && !hasPreOrderItems(order) && order.state === 'PaymentSettled' && (
        <div class="bg-[#F7F2EA] border border-[#E5E0D8] rounded-[3px] p-6">
          <h3 class="text-lg font-medium text-[#141210] mb-2 flex items-center gap-2">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Tracking Information
          </h3>
          <p class="text-[#645541]">Tracking will be updated once your order ships.</p>
        </div>
      )}

      {/* Tracking Information */}
      {trackingInfo.hasTracking && (
        <div class="bg-[#F7F2EA] border border-[#E5E0D8] rounded-[3px] p-6">
          <h3 class="text-lg font-medium text-[#141210] mb-4 flex items-center gap-2">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Tracking Information
          </h3>
          <div class="grid sm:grid-cols-2 gap-4">
            <div>
              <p class="text-sm font-medium text-[#141210]">Tracking Number</p>
              <a
                href={getTrackingUrl(trackingInfo.trackingCode!)}
                target="_blank"
                rel="noopener noreferrer"
                class="text-[#645541] font-mono text-lg hover:text-[#141210] underline underline-offset-2"
              >
                {getMaskedTrackingCode(trackingInfo.trackingCode!)}
              </a>
            </div>
            <div>
              <p class="text-sm font-medium text-[#141210]">Carrier</p>
              <p class="text-[#645541]">{trackingInfo.carrier}</p>
            </div>
          </div>
          <a
            href={getTrackingUrl(trackingInfo.trackingCode!)}
            target="_blank"
            rel="noopener noreferrer"
            class="mt-4 inline-flex bg-transparent border border-[#141210] text-[#141210] px-6 py-2 rounded-[3px] hover:bg-[#F5F0E8] transition-colors duration-200 font-medium items-center gap-2"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
            Track Package
          </a>
        </div>
      )}

      {/* Order Items */}
      <div class="bg-white border border-[#E5E0D8] rounded-[3px] overflow-hidden">
        <div class="bg-[#F7F2EA] px-6 py-4 border-b border-[#E5E0D8]">
          <h3 class="text-lg font-semibold text-[#141210]">Order Items</h3>
        </div>
        <div class="divide-y divide-[#E5E0D8]">
          {order.lines.map((line) => (
            <div key={line.id} class="p-6 flex gap-4">
              {/* Product image with proper aspect ratio */}
              <div class="flex-shrink-0 w-20 border border-[#E5E0D8] rounded-[3px] overflow-hidden">
                <div class="relative aspect-4/5">
                  {line.featuredAsset?.preview ? (
                    <OptimizedImage
                      src={line.featuredAsset.preview}
                      alt={line.productVariant.name}
                      class="w-full h-full object-cover object-center"
                      width={80}
                      height={100}
                    />
                  ) : (
                    <div class="w-full h-full bg-gray-100 flex items-center justify-center">
                      <svg class="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                      </svg>
                    </div>
                  )}
                </div>
              </div>
              {/* Product details */}
              <div class="flex-1 flex flex-col justify-between">
                <div>
                  <h4 class="font-semibold text-[#141210]">{line.productVariant.name}</h4>
                  <p class="text-sm text-[#7A7166] mt-1">SKU: {line.productVariant.sku}</p>
                  {/* Show ship date for pre-order items */}
                  {line.productVariant?.customFields?.preOrderPrice && (
                    <div class="mt-2">
                      {line.productVariant.customFields.shipDate ? (
                        <p class="text-sm text-[#645541] font-medium">
                          Expected to ship: {formatShipDate(new Date(line.productVariant.customFields.shipDate))}
                        </p>
                      ) : (
                        <p class="text-sm text-[#645541] font-medium">
                          Ship date to be announced
                        </p>
                      )}
                    </div>
                  )}
                </div>
                <div class="flex items-center justify-between mt-3">
                  <span class="text-sm text-[#645541] font-medium">Qty: {line.quantity}</span>
                  <div class="text-right">
                    <p class="font-semibold text-[#141210]">
                      {formatPrice(line.linePriceWithTax, order.currencyCode)}
                    </p>
                    <p class="text-sm text-[#7A7166]">
                      {formatPrice(line.unitPriceWithTax, order.currencyCode)} each
                    </p>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Order Summary & Shipping - More Compact */}
      <div class="grid lg:grid-cols-2 gap-6">
        {/* Order Summary */}
        <div class="bg-white border border-[#E5E0D8] rounded-[3px] p-5">
          <h3 class="text-lg font-semibold text-[#141210] mb-3">Order Summary</h3>
          <div class="space-y-2">
            <div class="flex justify-between text-sm">
              <span class="text-[#645541]">Subtotal</span>
              <span class="font-medium">{formatPrice(order.subTotalWithTax, order.currencyCode)}</span>
            </div>
            {order.shippingWithTax > 0 && (
              <div class="flex justify-between text-sm">
                <span class="text-[#645541]">Shipping</span>
                <span class="font-medium">{formatPrice(order.shippingWithTax, order.currencyCode)}</span>
              </div>
            )}
            <div class="border-t border-[#E5E0D8] pt-2">
              <div class="flex justify-between">
                <span class="font-semibold text-[#141210]">Total</span>
                <span class="font-semibold text-[#141210]">
                  {formatPrice(order.totalWithTax, order.currencyCode)}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Shipping Address */}
        {order.shippingAddress && (
          <div class="bg-white border border-[#E5E0D8] rounded-[3px] p-5">
            <h3 class="text-lg font-semibold text-[#141210] mb-3 flex items-center gap-2">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              Shipping Address
            </h3>
            <div class="text-[#645541] space-y-1 text-sm">
              <p class="font-medium text-[#141210]">{order.shippingAddress.fullName}</p>
              <p>{order.shippingAddress.streetLine1}</p>
              {order.shippingAddress.streetLine2 && (
                <p>{order.shippingAddress.streetLine2}</p>
              )}
              <p>
                {order.shippingAddress.city}, {order.shippingAddress.province} {order.shippingAddress.postalCode}
              </p>
              <p>{order.shippingAddress.country}</p>
              {order.shippingAddress.phoneNumber && (
                <p class="text-[#7A7166] mt-2">
                  Phone: {order.shippingAddress.phoneNumber}
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Payment Information - More Compact */}
      {order.payments && order.payments.length > 0 && (
        <div class="bg-white border border-[#E5E0D8] rounded-[3px] p-5">
          <h3 class="text-lg font-semibold text-[#141210] mb-3 flex items-center gap-2">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
            </svg>
            Payment Information
          </h3>
          {order.payments.map((payment) => (
            <div key={payment.id} class="flex justify-between items-center">
              <div>
                <p class="font-medium text-[#141210] text-sm">
                  {payment.method.replace(/([A-Z])/g, ' $1').trim()}
                </p>
                <p class="text-sm text-[#7A7166]">
                  {payment.state} • {formatDateTime(payment.createdAt)}
                </p>
              </div>
              <p class="font-semibold text-[#141210]">
                {formatPrice(payment.amount, order.currencyCode)}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
