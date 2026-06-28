import { createSEOHead } from '~/utils/seo';

export type TimelineStep = { key: string; label: string };

export const TIMELINE: TimelineStep[] = [
 { key: 'confirmed', label: 'Confirmed' },
 { key: 'processing', label: 'Processing' },
 { key: 'shipped', label: 'Shipped' },
 { key: 'delivered', label: 'Delivered' },
];

export const activeStepFromState = (state?: string): number => {
 switch (state) {
  case 'Delivered':
   return 3;
  case 'Shipped':
  case 'PartiallyShipped':
   return 2;
  case 'PaymentSettled':
  case 'PaymentAuthorized':
   return 1;
  default:
   return 0;
 }
};

export const head = ({ params }: { params: { code: string } }) => {
 return createSEOHead({
  title: 'Order Confirmation',
  description: `Thank you for your order${params?.code ? ' #' + params.code : ''} at Damned Designs. View your order summary and details.`,
  noindex: true,
 });
};
