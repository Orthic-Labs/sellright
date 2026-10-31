/**
 * L11: the checkout order summary at first paint. The checkout route's loader makes ONE extra live read of the cart the
 * request's `sr_cart` cookie names (pricingIntent=checkout), on the server, per document request: no cache, nothing kept
 * between requests. The result is DISPLAY ONLY: the summary shows it until the client's LOCKED checkout-entry read lands
 * and replaces it. It never reaches the cart mirror, never sets `pricingIntent` on the client cart, and never gates
 * PLACE ORDER (that still needs the client read's `localCart.cart.pricingIntent === 'checkout'`).
 *
 * Any failure, timeout or doubt is `null`: the page then behaves exactly as without this read (skeleton, client path).
 */
import { resolveAssetPath } from '~/sellright/types/catalog';
import type { Cart, ServerCart } from '~/sellright/types/cart';

/** Upper bound on the server read: past it the document renders without it (the skeleton, as before). */
export const SERVER_CART_TIMEOUT_MS = 1500;

/** The client's own default destination (CountryPreferenceService DEFAULT_COUNTRY) when nothing says otherwise. */
const DEFAULT_SHIP_COUNTRY = 'US';

/** The ship country the server read quotes for: the country cookie when it is a valid code, else the client's default. */
export function serverCartShipCountry(cookieValue: string | null | undefined): string {
  const code = (cookieValue ?? '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : DEFAULT_SHIP_COUNTRY;
}

/**
 * The display copy of a server cart, or null when it must not be shown: a response for another cart, a cart that is not
 * an active one (a converted cart resumes its order instead), a quote that is not the checkout quote, or no lines.
 * Identity fields (token, email, customer) are dropped: the summary does not use them and the page must not carry them.
 */
export function toDisplayCart(server: ServerCart | null | undefined, requestToken: string): Cart | null {
  if (!server || server.token !== requestToken) return null;
  if (server.status !== 'active' || server.pricingIntent !== 'checkout') return null;
  if (!Array.isArray(server.lines) || server.lines.length === 0) return null;
  return {
    ...server,
    token: '',
    email: null,
    customerId: null,
    // Same asset-root resolution as CartService.toCartLine (no client enrichment exists on a fresh document either).
    lines: server.lines.map((line) => ({ ...line, image: resolveAssetPath(line.image ?? null) })),
  };
}

type CartGet = (
  path: '/v1/shop/cart/{token}',
  init: {
    params: { path: { token: string }; query: { pricingIntent: 'checkout'; shipCountry: string } };
    signal: AbortSignal;
  },
) => Promise<{ data?: ServerCart }>;

/**
 * One live server-side GET of the checkout quote. Never throws, never logs the token: null on a missing token, an error,
 * an empty body or the timeout (the request is aborted, and the result is null even if the transport ignores the abort).
 */
export async function readCheckoutServerCart(
  get: CartGet,
  token: string | null | undefined,
  shipCountry: string,
  timeoutMs: number = SERVER_CART_TIMEOUT_MS,
): Promise<Cart | null> {
  if (!token) return null;
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => { abort.abort(); resolve(null); }, timeoutMs);
  });
  const read = (async () => {
    try {
      const { data } = await get('/v1/shop/cart/{token}', {
        params: { path: { token }, query: { pricingIntent: 'checkout', shipCountry } },
        signal: abort.signal,
      });
      return toDisplayCart(data, token);
    } catch {
      return null;
    }
  })();
  try {
    return await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export type SummarySource = 'client' | 'server' | 'skeleton';

/**
 * What the order summary renders. After loading: the client cart (unchanged). While loading: the client cart once the
 * checkout-entry live read has landed with an active cart; before that, the server read; else the skeleton.
 */
export function checkoutSummarySource(input: {
  pageLoading: boolean;
  entryReadDone: boolean;
  client: { status: string; lineCount: number };
  hasServerCart: boolean;
}): SummarySource {
  if (!input.pageLoading) return 'client';
  if (input.entryReadDone) return input.client.status === 'active' && input.client.lineCount > 0 ? 'client' : 'skeleton';
  return input.hasServerCart ? 'server' : 'skeleton';
}

/** A MIXED cart (pre-order and regular lines), as useHasMixedPreOrder computes it for the client cart. */
export function hasMixedPreOrder(lines: ReadonlyArray<{ isPreOrder?: boolean | null }>): boolean {
  return lines.some((l) => !!l.isPreOrder) && lines.some((l) => !l.isPreOrder);
}

/**
 * ADR-0001 #412: what the checkout loader returns for a cacheable shell (SHELL_CACHE=1): no cart and no price, only "this document
 * is the shell". The page then paints the form at once (it holds no per-visitor value) beside the reserved summary skeleton, and
 * starts the LOCKED checkout-entry live reads at document ready (qinit). With the switch off the loader never returns it.
 */
export interface CheckoutShellMarker {
  shell: true;
}

export const CHECKOUT_SHELL: CheckoutShellMarker = { shell: true };

/** The checkout loader's value: the L11 display cart, the shell marker, or nothing. */
export type ServerCartValue = Cart | CheckoutShellMarker | null;

export function isCheckoutShell(value: unknown): value is CheckoutShellMarker {
  return !!value && typeof value === 'object' && (value as { shell?: unknown }).shell === true;
}

/** The display cart of a loader value (null for the shell marker). */
export function displayServerCart(value: ServerCartValue | undefined): Cart | null {
  return value && !isCheckoutShell(value) ? value : null;
}
