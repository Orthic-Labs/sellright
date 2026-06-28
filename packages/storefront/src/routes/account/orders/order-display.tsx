import { component$ } from '@qwik.dev/core';
import { Order } from '~/generated/graphql-shop';

export const TruckIcon = component$(() => (
  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
  </svg>
));

export const CalendarIcon = component$(() => (
  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
  </svg>
));

export const ChevronDownIcon = component$(() => (
  <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
  </svg>
));

export const PackageIcon = component$(() => (
  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
  </svg>
));

const getLatestPreOrderShipDate = (order: any) => {
  if (!order?.lines) return null;
  const preOrderDates = order.lines
    .filter((line: any) => line.productVariant?.customFields?.preOrderPrice)
    .map((line: any) => line.productVariant?.customFields?.shipDate)
    .filter((date: any) => date)
    .map((date: any) => new Date(date))
    .filter((date: Date) => !isNaN(date.getTime()));
  return preOrderDates.length ? new Date(Math.max(...preOrderDates.map((date: Date) => date.getTime()))) : null;
};

const formatShipDate = (date: Date) => date.toLocaleDateString('en-US', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});

export const getStatusDisplay = (state: string, order?: any) => {
  if (state === 'PaymentSettled' && order?.customFields?.isPreOrder) {
    const latestShipDate = getLatestPreOrderShipDate(order);
    return {
      label: 'Pre-ordered',
      description: latestShipDate ? `Expected to ship around ${formatShipDate(latestShipDate)}` : 'Expected ship date to be announced',
      color: 'bg-[#F5F0E8] text-[#645541] border-[#D8D1C7]',
    };
  }

  switch (state) {
    case 'PartiallyShipped':
      return { label: 'Partially Shipped', color: 'bg-[#F5F0E8] text-[#645541] border-[#D8D1C7]' };
    case 'Shipped':
    case 'Delivered':
    case 'Cancelled':
      return { label: state, color: 'bg-[#F5F0E8] text-[#645541] border-[#D8D1C7]' };
    case 'Refunded':
      return { label: 'Refunded', color: 'bg-[#fee2e2] text-[#991b1b] border-[#fca5a5]' };
    default:
      return { label: 'Processing', color: 'bg-[#F5F0E8] text-[#645541] border-[#D8D1C7]' };
  }
};

export const getStatusIcon = (state: string) => {
  switch (state.toLowerCase()) {
    case 'shipped':
    case 'delivered':
      return <TruckIcon />;
    case 'paymentshipped':
    case 'partiallyshipped':
      return <PackageIcon />;
    default:
      return <CalendarIcon />;
  }
};

export const formatDate = (dateString: string) => {
  try {
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return 'Invalid Date';
    return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch (_error) {
    return 'Invalid Date';
  }
};

export const getTrackingInfo = (order: Order) => {
  const fulfillment = order.fulfillments?.find(f => f.trackingCode);
  return fulfillment
    ? { hasTracking: true, trackingCode: fulfillment.trackingCode, state: fulfillment.state }
    : { hasTracking: false };
};
