import { Order } from '~/generated/graphql-shop';

export const hasPreOrderItems = (order: Order) => {
 if (!order?.lines) return false;
 return order.lines.some((line: any) =>
  line.productVariant?.customFields?.preOrderPrice
 );
};

export const getLatestPreOrderShipDate = (order: Order) => {
 if (!order?.lines) return null;

 const preOrderDates = order.lines
  .filter((line: any) => line.productVariant?.customFields?.preOrderPrice)
  .map((line: any) => line.productVariant?.customFields?.shipDate)
  .filter((date: any) => date)
  .map((date: any) => new Date(date))
  .filter((date: Date) => !isNaN(date.getTime()));

 if (preOrderDates.length === 0) return null;

 const timestamps = preOrderDates.map((date: Date) => date.getTime());
 return new Date(Math.max(...timestamps));
};

export const formatShipDate = (date: Date) => {
 return date.toLocaleDateString('en-US', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
 });
};

export const getTrackingInfo = (order: Order) => {
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

export const getOrderStatus = (order: Order) => {
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
     icon: '🎯',
    };
   }
   return {
    status: 'Processing',
    description: 'Your payment has been processed and your order is being prepared.',
    color: 'text-[#141210]',
    bgColor: 'bg-[#F5F0E8]',
    icon: '💳',
   };
  }
  case 'Refunded':
   return {
    status: 'Refunded',
    description: 'Your order has been refunded.',
    color: 'text-[#141210]',
    bgColor: 'bg-[#F5F0E8]',
    icon: '↩️',
   };
  case 'PartiallyShipped':
   return {
    status: 'Partially Shipped',
    description: 'Some items from your order have been shipped.',
    color: 'text-[#141210]',
    bgColor: 'bg-[#F5F0E8]',
    icon: '📦',
   };
  case 'Shipped':
   return {
    status: 'Shipped',
    description: 'Your order has been shipped and is on its way.',
    color: 'text-[#141210]',
    bgColor: 'bg-[#F5F0E8]',
    icon: '🚛',
   };
  case 'Delivered':
   return {
    status: 'Delivered',
    description: 'Your order has been delivered.',
    color: 'text-[#141210]',
    bgColor: 'bg-[#F5F0E8]',
    icon: '✅',
   };
  case 'Cancelled':
   return {
    status: 'Cancelled',
    description: 'This order has been cancelled.',
    color: 'text-[#141210]',
    bgColor: 'bg-[#F5F0E8]',
    icon: '❌',
   };
  default:
   return {
    status: order.state.replace(/([A-Z])/g, ' $1').trim(),
    description: 'Your order is being processed.',
    color: 'text-[#141210]',
    bgColor: 'bg-[#F5F0E8]',
    icon: '⏳',
   };
 }
};

export const getTrackingUrl = (trackingCode: string) =>
 `https://tools.usps.com/go/TrackConfirmAction?qtc_tLabels1=${trackingCode}`;

export const getMaskedTrackingCode = (trackingCode: string) => {
 const normalized = trackingCode.trim();
 const suffix = normalized.slice(-8);
 return `...${suffix}`;
};
