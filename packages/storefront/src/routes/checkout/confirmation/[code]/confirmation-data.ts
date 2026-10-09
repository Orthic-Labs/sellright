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
  case 'Paid':
   return 1;
  default:
   // PendingPayment, AddingItems, Cancelled, Declined and any unrecognized
   // state all read as "just confirmed" — Cancelled/Declined get their own
   // banner in the route rather than a misleading mid-timeline step.
   return 0;
 }
};

/** True once the order has actually settled — gates the "clear the cart"
 *  side effect on the confirmation page. Never treat PendingPayment (still
 *  polling) or a terminal Cancelled/Declined order as settled. */
export const isOrderSettled = (state?: string): boolean => state === 'Paid' || state === 'Shipped' || state === 'PartiallyShipped' || state === 'Delivered';

/** True for a terminal, un-settleable order — the confirmation page shows a
 *  dedicated message instead of polling further. */
export const isOrderTerminalUnpaid = (state?: string): boolean => state === 'Cancelled' || state === 'Declined';

/** Builds an absolute-or-root asset URL from the API's stored path, mirroring
 *  the API's own static asset mount (`/assets/<path>`). Local to this route
 *  so confirmation has no dependency on the legacy `sr()` REST helper. */
export const assetUrl = (path: string): string => (/^(https?:\/\/|\/)/.test(path) ? path : `/assets/${path}`);

/** Resolves after `ms`, or immediately once `signal` aborts (never leaves a
 *  timer running behind an unmounted page). */
export const sleepAbortable = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });

/**
 * Read an order, re-reading while it is still PendingPayment (the gateway /
 * webhook that flips it to Paid may land a moment after the shopper does).
 * This NEVER upgrades the displayed state itself — it only re-reads.
 *
 * Abortable: when `signal` aborts (the page unmounted / navigated away) the
 * loop stops at once — no further requests, no sleeping timer — and the
 * result is `null`, which callers must treat as "page is gone, touch
 * nothing". `read` receives the signal so an in-flight request is cancelled
 * too.
 */
export async function readOrderUntilSettled<T extends { state: string }>(
  read: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  opts: { attempts?: number; delayMs?: number; sleep?: (ms: number, signal: AbortSignal) => Promise<void> } = {},
): Promise<T | null> {
  const { attempts = 8, delayMs = 1500, sleep = sleepAbortable } = opts;
  if (signal.aborted) return null;
  let order = await read(signal);
  for (let i = 0; i < attempts && order.state === 'PendingPayment'; i++) {
    await sleep(delayMs, signal);
    if (signal.aborted) return null;
    order = await read(signal);
  }
  return signal.aborted ? null : order;
}
