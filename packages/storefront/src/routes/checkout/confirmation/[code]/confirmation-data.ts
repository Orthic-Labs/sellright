import { variantLabel } from '~/utils/line-label';

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
 * stray trailing separator). Pass the line's productName snapshot when the API
 * has one (#346): the variant name is then the option label (product prefix
 * stripped, options joined by " · "). */
export const parseLineName = (
  variantName: string,
  knownProductName?: string | null,
): { productName: string; variantLabel: string } => {
  if (knownProductName) return { productName: knownProductName, variantLabel: variantLabel({ productName: knownProductName, variantName }) };
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

/** The address the "confirmation is on its way" line names: the order's contact email (`contactEmail`, where the API
 *  sends order mail; guests have no customer record), then the linked account email, then the address this browser
 *  session just entered at checkout. */
export const resolveConfirmationEmail = (
  order: { customerEmail?: string | null; contactEmail?: string | null },
  sessionEmail?: string | null,
): string | null => order.contactEmail || order.customerEmail || sessionEmail || null;

/** True once the order has actually settled — gates the "clear the cart"
 *  side effect on the confirmation page. Never treat PendingPayment (still
 *  polling) or a terminal Cancelled/Declined order as settled. */
export const isOrderSettled = (state?: string): boolean => state === 'Paid' || state === 'Shipped' || state === 'PartiallyShipped' || state === 'Delivered';

/** True for a terminal, un-settleable order — the confirmation page shows a
 *  dedicated message instead of polling further. */
export const isOrderTerminalUnpaid = (state?: string): boolean => state === 'Cancelled' || state === 'Declined';

/** Shown when verifying a gateway return threw, or the order is still unpaid after polling (the previous store's wording). */
export const PAYMENT_UNVERIFIED_MESSAGE = 'Unable to verify payment status. Please contact support if payment was deducted.';
export const PAYMENT_VERIFY_FAILED_MESSAGE = 'Payment verification failed';

/** What reconciling the shopper's return from a hosted gateway (the `paymentAttempt` query param) came to. */
export type GatewayVerifyOutcome =
  | { kind: 'none' } // not a gateway return, so nothing was verified
  | { kind: 'verified'; status: string; message?: string } // the API answered; `status` is the attempt's status
  | { kind: 'threw' }; // the verify call itself failed

/**
 * The message for the "Payment verification error" screen, or null when the page may show the order as usual. Only a
 * gateway return can fail verification, and only while the order is NOT settled: a settled order always wins (the
 * webhook may have landed while verify failed), and a cancelled/declined one has its own screen. Otherwise a failed or
 * unknown verification, a verify call that threw, or an order still PendingPayment once polling has ended, all mean the
 * payment was not confirmed — the page must never say "Thank you … confirmed" for it.
 */
export function gatewayReturnVerificationError(returnedFromGateway: boolean, verify: GatewayVerifyOutcome, orderState?: string): string | null {
  if (!returnedFromGateway) return null;
  if (isOrderSettled(orderState) || isOrderTerminalUnpaid(orderState)) return null;
  if (verify.kind === 'verified' && (verify.status === 'failed' || verify.status === 'unknown')) return verify.message || PAYMENT_VERIFY_FAILED_MESSAGE;
  if (verify.kind === 'threw') return PAYMENT_UNVERIFIED_MESSAGE;
  return orderState === 'PendingPayment' ? PAYMENT_UNVERIFIED_MESSAGE : null;
}

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

/** V29: re-read delays while an order is still PendingPayment — short first (a webhook usually lands within a second
 *  or two of the shopper's return), then backing off. Same ~12s window as the old fixed 8 x 1.5s schedule, but at most
 *  six re-reads instead of eight. */
export const CONFIRMATION_POLL_DELAYS_MS: readonly number[] = [750, 1000, 1500, 2000, 3000, 4000];

/**
 * Read an order, re-reading while it is still PendingPayment (the gateway /
 * webhook that flips it to Paid may land a moment after the shopper does).
 * This NEVER upgrades the displayed state itself — it only re-reads. It stops
 * at the first read whose state is anything but PendingPayment (settled,
 * cancelled, declined), so a settled order costs one request.
 *
 * Delays follow `CONFIRMATION_POLL_DELAYS_MS` (backoff); `attempts` caps the
 * number of re-reads, `delayMs` restores a fixed delay, `delaysMs` sets the
 * whole schedule.
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
  opts: { attempts?: number; delayMs?: number; delaysMs?: readonly number[]; sleep?: (ms: number, signal: AbortSignal) => Promise<void> } = {},
): Promise<T | null> {
  const { sleep = sleepAbortable } = opts;
  const base = opts.delaysMs
    ?? (opts.delayMs !== undefined ? Array.from({ length: opts.attempts ?? CONFIRMATION_POLL_DELAYS_MS.length }, () => opts.delayMs!) : CONFIRMATION_POLL_DELAYS_MS);
  const delays = opts.attempts !== undefined ? base.slice(0, opts.attempts) : base;
  if (signal.aborted) return null;
  let order = await read(signal);
  for (const delay of delays) {
    if (order.state !== 'PendingPayment') break;
    await sleep(delay, signal);
    if (signal.aborted) return null;
    order = await read(signal);
  }
  return signal.aborted ? null : order;
}
