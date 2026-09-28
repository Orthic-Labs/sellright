/**
 * Native SellRight account + auth types.
 *
 * The generated `schema.gen.ts` has no named `components.schemas` — this
 * OpenAPI document inlines every request/response shape directly on its
 * `paths` entry, so `components['schemas']` (aliased as `Schemas` by
 * `~/sellright/client`) is `never`. These types are derived straight from the
 * `paths` response/request bodies with indexed-access types instead, so they
 * can never drift from the API's own contract — regenerate `schema.gen.ts`
 * and these follow automatically, same guarantee `Schemas` would have given
 * if the API exposed named components.
 *
 * Zero Vendure shapes: no `__typename`, no GraphQL `ErrorResult` unions. Every
 * mutation here resolves to a plain `{ ok, ... }` / throws `SellRightError`;
 * branch on `SellRightError.code` (or `.status` when the API has no stable
 * code for that case) — never on a discriminated `__typename`.
 */
import type { paths } from '~/sellright/client';

type Json<P extends keyof paths, M extends 'get' | 'post' | 'patch' | 'delete', S extends number> = paths[P] extends {
	[K in M]: { responses: { [K2 in S]: { content: { 'application/json': infer B } } } };
}
	? B
	: never;

type Body<P extends keyof paths, M extends 'get' | 'post' | 'patch' | 'delete'> = paths[P] extends {
	[K in M]: { requestBody?: { content: { 'application/json': infer B } } };
}
	? B
	: never;

/** The customer record returned by register / login / GET me. */
export type AuthCustomer = Json<'/v1/shop/auth/me', 'get', 200>;

/** The (slightly narrower) customer record returned by PATCH /account/me. */
export type ProfileUpdateResult = Json<'/v1/shop/account/me', 'patch', 200>;

/** Result of a successful login or register call. */
export type LoginResponse = Json<'/v1/shop/auth/login', 'post', 200>;

/** A live session: the current customer, or `null` when signed out. */
export type Session = AuthCustomer | null;

/** One saved address, as the API returns it. */
export type Address = Json<'/v1/shop/account/addresses', 'get', 200>['items'][number];

/** Body for creating a new address. */
export type NewAddressInput = Body<'/v1/shop/account/addresses', 'post'>;

/** Body for updating an existing address — every field optional. */
export type AddressPatch = Body<'/v1/shop/account/addresses/{id}', 'patch'>;

/** One row of the paginated order-history list. */
export type AccountOrderSummary = Json<'/v1/shop/account/orders', 'get', 200>['items'][number];

/** The full paginated order-history response — `total` is the server's real count, not the page length. */
export type AccountOrderList = Json<'/v1/shop/account/orders', 'get', 200>;

/** A single owned order, in full (payments, fulfillments, lines). */
export type AccountOrderDetail = Json<'/v1/shop/account/orders/{code}', 'get', 200>;

/** Points balance + recent activity for the current customer. */
export type LoyaltyBalance = Json<'/v1/shop/account/loyalty', 'get', 200>;

/** Stable, storefront-facing account error codes. Prefers `SellRightError.code`
 *  when the API supplies one (currently only `not_verified` on login); falls
 *  back to a status-derived code for the cases the API signals by HTTP status
 *  alone. Never a Vendure `errorCode` / `__typename`. */
export type AccountErrorCode =
	| 'not_verified'
	| 'invalid_credentials'
	| 'email_taken'
	| 'rate_limited'
	| 'bot_check_failed'
	| 'invalid_token'
	| 'wrong_password'
	| 'email_unavailable'
	| 'unauthenticated'
	| 'not_found'
	| 'unknown';

export interface AccountError {
	code: AccountErrorCode;
	message: string;
}

/** Human-facing fallback copy per code — callers may override per-flow. */
const DEFAULT_MESSAGE: Record<AccountErrorCode, string> = {
	not_verified: 'Please verify your email before signing in.',
	invalid_credentials: 'Invalid email or password.',
	email_taken: 'That email is already registered.',
	rate_limited: 'Too many attempts — please try again later.',
	bot_check_failed: 'Security check failed. Please try again.',
	invalid_token: 'This link is invalid, expired, or already used.',
	wrong_password: 'Current password is incorrect.',
	email_unavailable: 'That email address is unavailable.',
	unauthenticated: 'Please sign in and try again.',
	not_found: 'Not found.',
	unknown: 'Something went wrong. Please try again.',
};

/** Minimal shape needed from `SellRightError` without importing the class
 *  itself (keeps this module import-cycle free — `client.ts` imports nothing
 *  from here). */
export interface AccountErrorLike {
	status: number;
	code?: string;
	message: string;
}

/** Map a thrown `SellRightError` (or any error-shaped value) onto a stable
 *  `AccountError`. `statusCodes` lets a call site say "409 means X here" since
 *  the same status means different things on different endpoints (409 is
 *  "email taken" on register, "invalid token" on reset-password). */
export function describeAccountError(
	e: unknown,
	statusCodes: Partial<Record<number, AccountErrorCode>> = {},
): AccountError {
	const err = e as Partial<AccountErrorLike> | null | undefined;
	const status = typeof err?.status === 'number' ? err.status : undefined;

	if (err?.code === 'not_verified') {
		return { code: 'not_verified', message: DEFAULT_MESSAGE.not_verified };
	}
	if (status === 429) {
		return { code: 'rate_limited', message: DEFAULT_MESSAGE.rate_limited };
	}
	if (status === 403) {
		return { code: 'bot_check_failed', message: DEFAULT_MESSAGE.bot_check_failed };
	}
	if (status !== undefined && statusCodes[status]) {
		const code = statusCodes[status]!;
		return { code, message: DEFAULT_MESSAGE[code] };
	}
	if (status === 401) return { code: 'unauthenticated', message: DEFAULT_MESSAGE.unauthenticated };
	if (status === 404) return { code: 'not_found', message: DEFAULT_MESSAGE.not_found };
	return { code: 'unknown', message: err?.message || DEFAULT_MESSAGE.unknown };
}
