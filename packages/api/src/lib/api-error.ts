/**
 * SR-CLIENT-1 (storefront-client audit): the structured error envelope every
 * route in this API now returns for non-2xx JSON responses:
 *
 *   { error: { code, message, param?, requestId? }, ...siblingFields }
 *
 * Replaces the old bare `{ error: string }` shape. `code` is a STABLE,
 * machine-checkable identifier a typed client can branch on (never changes
 * wording); `message` stays the human-readable string for display; `param`
 * names the offending field for validation errors; `requestId` is the same
 * id `requestIdMiddleware` (lib/request-id.ts) attaches to the response
 * header and the structured logs, so a support ticket can be traced to one
 * log line. `requestId` is best-effort (omitted when the middleware hasn't
 * run yet — e.g. errors thrown before it's registered, which doesn't happen
 * in this app's middleware order, but the type stays optional defensively).
 *
 * Sibling fields that already carry BUSINESS state alongside an error body —
 * cart-conflict's `code`/`revision`/`cart` (SrCartConflict), pay's `state`,
 * the maintenance gate's `maintenance: true` — are preserved as top-level
 * siblings of `error`, exactly as before. Only the VALUE of `error` changed
 * shape (string -> object); nothing else in any existing response moved.
 *
 * Rollout (see docs — PR: structured error envelope): `HttpError` (used by
 * the admin surface via app.ts's central `onError`) now derives `code`
 * automatically from its message when the throw site doesn't pass one
 * explicitly, so all 145 existing `new HttpError(status, message)` call
 * sites keep compiling and now return the new envelope for free. The
 * shop-facing route files (catalog/cart/checkout/pay/gateway-payments/auth/
 * account/customer-tokens/orders/loyalty/shop-extra/subscriptions/contact/
 * restock/sheerid) were converted call-site-by-call-site to `errJson` below
 * with deliberate, hand-picked codes — that's the surface the storefront
 * client's typed errors key on. Admin endpoints that build `c.json({error})`
 * directly (bypassing HttpError/onError) are NOT yet converted — tracked as
 * a followup, out of scope for the client audit (the client doesn't call
 * admin endpoints).
 */
import type { Context } from 'hono';
import { z } from '@hono/zod-openapi';

export type HttpStatus = 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 502 | 503;

/** Deterministic fallback when a throw/return site doesn't pass an explicit
 *  code: upper-snake-case the message, strip anything that isn't alnum/space,
 *  cap at 64 chars so a long interpolated message doesn't produce an
 *  unbounded "code". Stable as long as the message string itself doesn't
 *  change — good enough for the untouched admin/legacy call sites; every
 *  shop-facing call site passes an explicit, wording-independent code
 *  instead of relying on this. */
export function slugifyCode(message: string): string {
  const slug = message
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9\s_]/g, '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '_')
    .slice(0, 64);
  return slug || 'ERROR';
}

/**
 * Every stable, hand-picked `code` a shop-facing route (`errJson` call site)
 * passes explicitly — see the rollout note above. This is the client's
 * error-branching surface: registered as its own `ApiErrorCode` OpenAPI
 * components schema (app.ts, via `app.openAPIRegistry.register`) so a
 * generated client gets a real union type instead of `string`, without
 * narrowing `error.code` on the wire (admin/legacy call sites still emit
 * arbitrary `slugifyCode`-derived codes, and `error.code` stays `z.string()`
 * everywhere at runtime — this list is documentation-only, not a validator).
 * Keep sorted; add a new shop-facing code here when you add a new `errJson`
 * call site — `api-error.codes.test.ts` fails the build if the two drift.
 */
export const SHOP_API_ERROR_CODES = [
  'ACTIVE_SUBSCRIPTION_EXISTS',
  'ADDRESS_NOT_FOUND',
  'ALREADY_REVIEWED',
  'APPLE_SIGNIN_NOT_CONFIGURED',
  'APPLE_TOKEN_INVALID',
  'AUTH_REQUIRED',
  'BIRTHDAY_ALREADY_SET',
  'BOT_CHECK_FAILED',
  'CART_INVALID',
  'CART_NOT_FOUND',
  'COLLECTION_NOT_FOUND',
  'CSRF_INVALID',
  'DOWNLOAD_NOT_FOUND',
  'DOWNLOADS_NOT_CONFIGURED',
  'EMAIL_NOT_VERIFIED',
  'EMAIL_SAME',
  'EMAIL_TAKEN',
  'EMAIL_TAKEN_UNVERIFIED',
  'GIFT_CARD_NOT_FOUND',
  'GOOGLE_SIGNIN_NOT_CONFIGURED',
  'GOOGLE_TOKEN_INVALID',
  'IDEMPOTENCY_KEY_REQUIRED',
  'IDEMPOTENCY_PAYLOAD_MISMATCH',
  'INVALID_BIRTHDAY',
  'INVALID_CHECKOUT_REQUEST',
  'INVALID_CREDENTIALS',
  'INVALID_PAYMENT_REQUEST',
  'INVITE_INVALID',
  'LEGAL_ACCEPTANCE_REQUIRED',
  'LICENSE_KEY_MISSING',
  'LICENSE_NOT_ACTIVE',
  'LICENSE_NOT_FOUND',
  'LOYALTY_REDEEM_FAILED',
  'MAGIC_LINK_DISABLED',
  'MAGIC_LINK_INVALID',
  'NOT_AUTHENTICATED',
  'NOT_RETURNABLE',
  'ORDER_ALREADY_PAID',
  'ORDER_NOT_FOUND',
  'ORDER_NOT_PAYABLE',
  'OUT_OF_STOCK',
  'PASSWORD_INCORRECT',
  'PAYMENT_METHOD_DISABLED',
  'PAYMENT_METHOD_UNKNOWN',
  'PAYMENT_NOT_FOUND',
  'POST_NOT_FOUND',
  'PRODUCT_NOT_FOUND',
  'PURCHASE_REQUIRED',
  'RATE_LIMITED',
  'REVIEWS_DISABLED',
  'SEAT_LIMIT_REACHED',
  'SECURITY_CHECK_FAILED',
  'SHIPPING_UNAVAILABLE',
  'SIGN_IN_REQUIRED',
  'STRIPE_NOT_CONFIGURED',
  'SUBSCRIPTION_NOT_FOUND',
  'TOKEN_INVALID',
  'VARIANT_NOT_RECURRING',
] as const;

export type ShopApiErrorCode = (typeof SHOP_API_ERROR_CODES)[number];

/** Registered once, in app.ts, as the `ApiErrorCode` components schema —
 *  NOT used as `error.code`'s runtime type (see the const above). */
export function apiErrorCodeSchema() {
  return z.enum(SHOP_API_ERROR_CODES).openapi('ApiErrorCode');
}

export interface ApiErrorFields {
  code: string;
  message: string;
  param?: string;
  requestId?: string;
}

export interface ApiErrorBody {
  error: ApiErrorFields;
}

/** OpenAPI response schema for the envelope — every shop-facing route's
 *  non-2xx `content` should reference this (optionally `.extend()`-ed with
 *  sibling fields), not a hand-rolled `z.object({ error: z.string() })`. */
export function apiErrorSchema() {
  return z
    .object({
      error: z.object({
        code: z.string(),
        message: z.string(),
        param: z.string().optional(),
        requestId: z.string().optional(),
      }),
    })
    .openapi('ApiError');
}

function requestIdOf(c: Context): string | undefined {
  return (c.var as { requestId?: string } | undefined)?.requestId;
}

/** Build the envelope body (for callers that need the object, not a Response —
 *  e.g. tests, or a handler composing a larger body manually). `extra` fields
 *  are spread as TOP-LEVEL siblings of `error`, never nested inside it.
 *
 *  Generic over `E`, defaulted to `Record<string, unknown>` — NOT
 *  `Record<string, never>`, which looks like the "no extra fields" case but
 *  isn't: intersecting `ApiErrorBody & Record<string, never>` forces EVERY
 *  property including `error` to type `never`, which TypeScript collapses to
 *  `{}` and silently erases `error` from the no-extra case. `Record<string,
 *  unknown>` doesn't have that problem, and when a caller DOES pass a
 *  concrete `extra` object TS infers `E` from that argument (not the
 *  default), giving the exact shape — e.g. `{ state: out.state }` infers
 *  `E = { state: string }`. Hono's typed `createRoute` responses check the
 *  handler's return type structurally against the declared Zod schema, so
 *  this has to be exact. */
export function errorEnvelope<E extends Record<string, unknown> = Record<string, unknown>>(
  c: Context,
  code: string,
  message: string,
  opts: { param?: string; extra?: E } = {},
): ApiErrorBody & E {
  const requestId = requestIdOf(c);
  return {
    ...(opts.extra ?? ({} as E)),
    error: {
      code,
      message,
      ...(opts.param ? { param: opts.param } : {}),
      ...(requestId ? { requestId } : {}),
    },
  } as ApiErrorBody & E;
}

/** `c.json(errorEnvelope(...), status)` in one call — the usual call site.
 *  Generic over the status literal (not widened to `HttpStatus`) so Hono's
 *  typed-route inference matches the exact status code declared in the
 *  route's `responses` map — a plain `HttpStatus` parameter type would widen
 *  every call to the full union and break `createRoute`'s per-status
 *  response-body typing. Also generic over `E` — see `errorEnvelope`. */
export function errJson<S extends HttpStatus, E extends Record<string, unknown> = Record<string, unknown>>(
  c: Context,
  status: S,
  code: string,
  message: string,
  opts: { param?: string; extra?: E } = {},
) {
  return c.json(errorEnvelope<E>(c, code, message, opts), status);
}
