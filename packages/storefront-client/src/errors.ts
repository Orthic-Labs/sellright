/**
 * Typed errors for the SellRight storefront client. Every non-2xx response
 * from the API is the structured envelope defined in
 * packages/api/src/lib/api-error.ts: `{ error: { code, message, param?,
 * requestId? }, ...siblingFields }`. `ApiError` mirrors that shape so a
 * consumer can branch on `.code` (stable, never changes wording) instead of
 * pattern-matching `.message` (display text, can be reworded any time).
 */

export interface ApiErrorFields {
  code: string;
  message: string;
  param?: string;
  requestId?: string;
}

/** The raw envelope body, plus whatever sibling fields the endpoint attaches
 *  (cart-conflict's `code`/`revision`/`cart`, pay's `state`, etc. — see the
 *  per-endpoint response types in `generated/schema.d.ts`). Kept as an open
 *  record on `ApiError.body` so callers needing those fields don't have to
 *  re-parse the response themselves. */
export type ApiErrorBody = { error: ApiErrorFields } & Record<string, unknown>;

export class ApiError extends Error {
  /** HTTP status code. */
  public readonly status: number;
  /** Stable machine code from the envelope — branch on this, not `.message`. */
  public readonly code: string;
  /** The offending field name, for validation errors. */
  public readonly param?: string;
  /** Correlates with the API's structured logs and its `x-request-id` response header. */
  public readonly requestId?: string;
  /** The full parsed response body (error envelope + any sibling fields). */
  public readonly body: ApiErrorBody;

  constructor(status: number, body: ApiErrorBody) {
    super(body.error?.message ?? `Request failed with status ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.error?.code ?? 'UNKNOWN_ERROR';
    this.param = body.error?.param;
    this.requestId = body.error?.requestId;
    this.body = body;
  }

  /** True for the well-formed `{ error: { code, message } }` envelope; false
   *  for anything else (a non-JSON error page from an intermediary proxy, a
   *  network-level failure surfaced as a Response, etc.) — those still
   *  produce an `ApiError` (via `unknownApiError`) but with a generic code. */
  static isEnvelope(body: unknown): body is ApiErrorBody {
    return (
      typeof body === 'object' &&
      body !== null &&
      'error' in body &&
      typeof (body as { error?: unknown }).error === 'object' &&
      (body as { error?: unknown }).error !== null &&
      typeof (body as { error: { code?: unknown } }).error.code === 'string' &&
      typeof (body as { error: { message?: unknown } }).error.message === 'string'
    );
  }
}

/** Thrown when the request never got a response at all — DNS/connection
 *  failure, or the configured timeout elapsed first. Distinct from
 *  `ApiError` (which always means the SERVER answered, just with a non-2xx
 *  status) so callers can tell "the API said no" from "the API was
 *  unreachable" — the fail-closed stock/cart rules depend on that
 *  distinction (see the client's `timeoutMs` option). */
export class NetworkError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'NetworkError';
  }
}

/** Build an `ApiError` from a Response whose body is NOT (or couldn't be
 *  parsed as) the structured envelope — a proxy/edge error page, an empty
 *  body, etc. Never silently swallows the failure as a 2xx. */
export function unknownApiError(status: number, rawBody: unknown): ApiError {
  const body: ApiErrorBody = ApiError.isEnvelope(rawBody)
    ? rawBody
    : { error: { code: 'UNKNOWN_ERROR', message: `Request failed with status ${status}` } };
  return new ApiError(status, body);
}
