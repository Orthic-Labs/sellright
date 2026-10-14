// License commerce flow: the REST calls of the license buy-flow (catalog by collection, one-SKU checkout with the legal
// acceptance contract, two-phase Stripe, customer auth and account). Store resolution: the pinned slug (x-store-slug) from SSR
// and the browser alike, else SSR forwards the request host (utils/sellright.ts). SSR calls the API directly; the browser uses
// relative `/v1` paths that the host proxies to the API (same origin, no CORS). The customer session is the API's httpOnly
// `sr_cust` cookie only: no token is read from a response or stored client-side. Plugin endpoints (devices, upgrade credit) come
// from src/brand/license.json, never from this file.
import { isServer } from '@qwik.dev/core/build';
import { apiBase, storeResolutionHeaders } from '~/utils/sellright';
import { BRAND_LICENSE } from '~/platform/brand-data';

/** A build pinned to one store sends its slug from the browser too (the API never has to infer the store from the Host). */
const PINNED_SLUG = (import.meta.env.VITE_SELLRIGHT_STORE_SLUG as string | undefined) || '';

function url(path: string): string {
	return isServer ? `${apiBase()}${path}` : path;
}

function getCookie(name: string): string | undefined {
	if (isServer || typeof document === 'undefined') return undefined;
	const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
	return match ? decodeURIComponent(match[1]!) : undefined;
}

export type ApiError = Error & { status?: number; body?: string };

async function sr<T>(path: string, init: RequestInit = {}): Promise<T> {
	const method = (init.method ?? 'GET').toUpperCase();
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		...(PINNED_SLUG ? { 'x-store-slug': PINNED_SLUG } : storeResolutionHeaders()),
		...(init.headers as Record<string, string> | undefined),
	};
	// Double-submit CSRF for cookie-authenticated mutations: the readable `sr_cust_csrf` cookie echoed back.
	if (method !== 'GET' && method !== 'HEAD') {
		const csrf = getCookie('sr_cust_csrf');
		if (csrf) headers['x-csrf-token'] = csrf;
	}
	const res = await fetch(url(path), { ...init, headers, credentials: 'include' });
	if (!res.ok) {
		let detail = '';
		try { detail = await res.text(); } catch { /* ignore */ }
		const err = new Error(`SellRight ${path} ${res.status}: ${detail}`) as ApiError;
		err.status = res.status;
		err.body = detail;
		throw err;
	}
	if (res.status === 204) return undefined as T;
	return (await res.json()) as T;
}

// ── runtime config (active Stripe mode + publishable key) ──
export interface ShopConfig { stripeMode: 'test' | 'live'; stripePublishableKey: string | null; stripeConfigured: boolean }
export const getShopConfig = () => sr<ShopConfig>('/v1/shop/config');

// ── catalog (a variant's collection) ──
export interface ProductListItem { slug: string; name: string; minPrice: number | null; image?: string | null }
export interface CollectionFeed { slug: string; name: string; description: string | null; products: ProductListItem[] }
export const getCollection = (slug: string) => sr<CollectionFeed>(`/v1/shop/collections/${encodeURIComponent(slug)}`);

/** Exactly the public catalog fields this flow reads. */
export interface VariantDetail {
	sku: string; name: string; price: number; salePrice: number | null; compareAtPrice: number | null;
	isPreOrder: boolean; enabled: boolean;
	fulfillmentType: 'physical' | 'digital_download' | 'license' | 'update_pass';
	appKey: string | null;
}
export interface ProductDetail { slug: string; name: string; description: string | null; variants: VariantDetail[] }
export const getProduct = (slug: string) => sr<ProductDetail>(`/v1/shop/catalog/products/${encodeURIComponent(slug)}`);

// ── checkout + payment (two-phase Stripe) ──
export interface CheckoutBody {
	items: { sku: string; quantity: number }[];
	mobileUpgradeSourceId?: string;
	upgradeCreditTerms?: { version: string; accepted: true };
	email?: string;
	billingAddress?: Record<string, unknown>;
	couponCode?: string;
	cartToken?: string;
	expectedRevision?: number;
	legalAcceptance?: {
		acceptanceVersion: string;
		eligibilityBasis: 'individual' | 'enterprise';
		authorityConfirmed: true;
		agreementStatement: string;
		documents: Array<{
			role: 'license' | 'eula' | 'acceptable_use' | 'product_schedule' | 'privacy_notice';
			id: string; version: string; sha256: string; url: string; treatment: 'agree' | 'acknowledge';
		}>;
	};
}
export interface CreatedOrder { code: string; state: string; grandTotal: number; discountTotal: number; currency: string; receiptToken?: string }
export const checkout = (body: CheckoutBody, idempotencyKey?: string) =>
	sr<CreatedOrder>('/v1/shop/checkout', {
		method: 'POST', body: JSON.stringify(body),
		headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : undefined,
	});

export interface PaymentIntent { clientSecret: string; intentId: string }
/** 503 when Stripe is not configured yet: the caller treats that as inert. */
export const createPaymentIntent = (code: string) =>
	sr<PaymentIntent>(`/v1/shop/orders/${encodeURIComponent(code)}/payment-intent`, { method: 'POST', body: '{}' });

export interface PayResult { code: string; state: string; payment: string }
export const payOrder = (code: string, paymentIntentId: string) =>
	sr<PayResult>(`/v1/shop/orders/${encodeURIComponent(code)}/pay`, {
		method: 'POST', body: JSON.stringify({ method: 'stripe', token: { paymentIntentId } }),
	});

// ── auth + account ── (the JSON `token` is for bearer clients; this flow relies on the Set-Cookie of the same response)
export interface AuthResult { token: string; customer: { email: string } }
export const register = (email: string, password: string, turnstileToken: string) =>
	sr<AuthResult>('/v1/shop/auth/register', { method: 'POST', body: JSON.stringify({ email, password, turnstileToken }) });
export const login = (email: string, password: string, turnstileToken: string) =>
	sr<AuthResult>('/v1/shop/auth/login', { method: 'POST', body: JSON.stringify({ email, password, turnstileToken }) });
export const me = () => sr<{ email: string }>('/v1/shop/auth/me');
export const logout = () => sr<{ ok: boolean }>('/v1/shop/auth/logout', { method: 'POST', body: '{}' });
/** Always `{ ok: true }` whether or not the email is registered (no enumeration oracle). */
export const requestMagicLink = (email: string, turnstileToken: string) =>
	sr<{ ok: boolean }>('/v1/shop/auth/magic-link/request', { method: 'POST', body: JSON.stringify({ email, turnstileToken }) });
export const consumeMagicLink = (token: string) =>
	sr<AuthResult>('/v1/shop/auth/magic-link/consume', { method: 'POST', body: JSON.stringify({ token }) });
/** forgot-password always answers `{ ok: true }`; reset-password 409s on an invalid, expired or used token. */
export const requestPasswordReset = (email: string, turnstileToken: string) =>
	sr<{ ok: boolean }>('/v1/shop/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email, turnstileToken }) });
export const resetPassword = (token: string, password: string) =>
	sr<{ ok: boolean }>('/v1/shop/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, password }) });

/** GDPR erasure. 409 means an active subscription must be cancelled first. */
export const deleteAccount = () => sr<{ deleted: boolean }>('/v1/shop/account', { method: 'DELETE' });

export interface License {
	licenseKey: string; appKey: string; status: string; seats: number;
	updatesUntil: string | null; expiresAt: string | null;
	createdAt?: string; orderCode?: string | null; latestVersion?: string | null;
	download?: { version: string; url: string } | null;
}
export const myLicenses = () => sr<{ items: License[] }>('/v1/shop/account/licenses');

// ── plugin features declared in src/brand/license.json ──
/** Mirrors the plugin's device shape: keyed by `id`; platform, pool, label and lastSeenAt are nullable and never defaulted. */
export interface Device {
	id: string; licenseKey: string; appKey: string;
	platform: string | null; pool: string | null; label: string | null;
	state: string; lastSeenAt: string | null; activatedAt: string; generation: number;
}
const DEVICES = BRAND_LICENSE?.devices?.endpoint ?? '';
const missing = (feature: string) => Promise.reject(Object.assign(new Error(`${feature} is not enabled`), { status: 404 }));
export const myDevices = () => (DEVICES ? sr<{ items: Device[] }>(DEVICES) : missing('devices'));
export const renameDevice = (id: string, label: string) =>
	DEVICES ? sr<{ ok: boolean }>(`${DEVICES}/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ label }) }) : missing('devices');
/** Remote removal frees the device's pool slot: re-activating elsewhere is how a seat moves. */
export const removeDevice = (id: string) =>
	DEVICES ? sr<{ ok: boolean }>(`${DEVICES}/${encodeURIComponent(id)}`, { method: 'DELETE' }) : missing('devices');

export interface UpgradePendingOrder { code: string; receiptToken: string | null; grandTotal: number }
export interface UpgradeOffer {
	eligible: true; sourceLicenseId: string; sku: string; currency: string;
	fullPrice: number; credit: number; upgradePrice: number; pendingOrder?: UpgradePendingOrder;
}
export type UpgradeEligibility = UpgradeOffer | { eligible: false };
const UPGRADE = BRAND_LICENSE?.upgradeCredit?.endpoint ?? '';
export const getUpgradeEligibility = () => (UPGRADE ? sr<UpgradeEligibility>(UPGRADE) : missing('upgradeCredit'));
