/**
 * Native SellRight API client for the storefront.
 *
 * Types come from `schema.gen.ts`, generated from the API's own OpenAPI
 * document (`/v1/openapi.json`), so requests and responses can't drift from
 * the backend. Regenerate with `pnpm gen:sellright-types`.
 *
 * This is the only way storefront code should talk to the API. It carries
 * over the transport behaviour of the old `sr()` helper: per-request API base
 * on the server, cookie forwarding during SSR, double-submit CSRF on browser
 * mutations, store resolution headers and a bounded SSR timeout.
 */
import createClient, { type Middleware } from 'openapi-fetch';
import { isServer } from '@qwik.dev/core/build';
import type { paths, components } from './schema.gen';
import { apiBase, storeResolutionHeaders } from '~/utils/sellright';
import { sellrightRequestCookie } from '~/utils/sellright-request-context.server';

export type { paths, components };
export type Schemas = components['schemas'];

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function readCsrfCookie(): string | undefined {
	if (isServer || typeof document === 'undefined') return undefined;
	// Customer sessions on the API use sr_cust_csrf; the isolated demo uses sr_csrf.
	for (const name of ['sr_cust_csrf', 'sr_csrf']) {
		const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
		if (match) return decodeURIComponent(match[1]);
	}
	return undefined;
}

/** Error thrown for any non-2xx response. `code` is the API's stable error
 *  code when the response carries one; branch on it, never on `message`. */
export class SellRightError extends Error {
	constructor(
		readonly status: number,
		readonly code: string | undefined,
		message: string,
		readonly body: unknown,
	) {
		super(message);
		this.name = 'SellRightError';
	}
}

const transport: Middleware = {
	onRequest({ request }) {
		for (const [k, v] of Object.entries(storeResolutionHeaders())) request.headers.set(k, v);
		if (isServer) {
			const cookie = sellrightRequestCookie.getStore();
			if (cookie) request.headers.set('cookie', cookie);
		} else if (MUTATING_METHODS.has(request.method.toUpperCase())) {
			const csrf = readCsrfCookie();
			if (csrf) request.headers.set('x-csrf-token', csrf);
		}
		return request;
	},
	async onResponse({ response }) {
		if (response.ok) return response;
		const text = await response.clone().text();
		let body: unknown;
		try { body = JSON.parse(text); } catch { body = undefined; }
		const err = (body as { error?: unknown } | undefined)?.error;
		const code = typeof err === 'object' && err !== null ? (err as { code?: string }).code : undefined;
		const message =
			typeof err === 'string' ? err
			: typeof err === 'object' && err !== null && typeof (err as { message?: unknown }).message === 'string' ? (err as { message: string }).message
			: `HTTP ${response.status}`;
		throw new SellRightError(response.status, code, message, body);
	},
};

function boundedFetch(input: Request): Promise<Response> {
	// Server-side calls must resolve within a bounded window (SSR/SSG), so an
	// unreachable API can never hang a render.
	if (isServer && !input.signal?.aborted) {
		return fetch(new Request(input, { signal: AbortSignal.timeout(8000) }));
	}
	return fetch(input);
}

/** Create a client for this request. On the server the API base is resolved
 *  per request; in the browser, calls are same-origin. */
export function sellright() {
	const client = createClient<paths>({
		baseUrl: isServer ? apiBase() : '',
		credentials: 'include',
		fetch: boundedFetch,
	});
	client.use(transport);
	return client;
}

/** Idempotency header for retry-safe mutations such as checkout. */
export function idempotency(key: string): { 'idempotency-key': string } {
	return { 'idempotency-key': key };
}
