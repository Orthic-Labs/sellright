import { createSEOHead } from '~/utils/seo';
import { theme } from '~/theme/theme.config';

export type TimelineStep = { key: string; label: string };

export const TIMELINE: TimelineStep[] = [
 { key: 'confirmed', label: 'Confirmed' },
 { key: 'processing', label: 'Processing' },
 { key: 'shipped', label: 'Shipped' },
 { key: 'delivered', label: 'Delivered' },
];

/** Splits a snapshot line's variant name into a product name + variant option
 * label. Order lines from GET /v1/shop/orders/{code} never carry
 * productVariant.product.name (only the variant name snapshot at purchase
 * time), and the seed/checkout convention writes that name as
 * "<Product Name> / <Option>" (see deploy/demo/visitors.mjs) — so split on
 * the literal " / " delimiter, not the last whitespace token. A last-word
 * split mangled multi-word option names, e.g. "Studio Notebook / Sage"
 * became productName "Studio Notebook /" (dropping only "Sage" and leaving a
 * stray trailing separator). Pass a real product name when one IS known
 * (e.g. the account-orders page, which fetches it separately) to skip the
 * split entirely. */
export const parseLineName = (
  variantName: string,
  knownProductName?: string | null,
): { productName: string; variantLabel: string } => {
  if (knownProductName) return { productName: knownProductName, variantLabel: '' };
  if (!variantName) return { productName: 'Product', variantLabel: '' };
  if (!variantName.includes(' / ')) return { productName: variantName, variantLabel: '' };
  const [productNamePart, ...optionParts] = variantName.split(' / ');
  return { productName: productNamePart || 'Product', variantLabel: optionParts.join(' / ') };
};

export const activeStepFromState = (state?: string): number => {
 switch (state) {
  case 'Delivered':
   return 3;
  case 'Shipped':
  case 'PartiallyShipped':
   return 2;
  case 'PaymentSettled':
  case 'PaymentAuthorized':
  case 'Paid':
   return 1;
  default:
   return 0;
 }
};

export const head = ({ params }: { params: { code: string } }) => {
 return createSEOHead({
  title: 'Order Confirmation',
  description: `Thank you for your order${params?.code ? ' #' + params.code : ''} at ${theme.storeName}. View your order summary and details.`,
  noindex: true,
 });
};
