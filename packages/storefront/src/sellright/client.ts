/**
 * Native SellRight API client for the storefront — thin Qwik adapter over
 * `@sellright/storefront-client`'s framework-agnostic `sellright()`/
 * `SellRightError`/`idempotency()` compat surface (see that package's
 * `compat.ts` doc comment). This file's only job is to call
 * `configureSellRightClient()` once with this app's own environment
 * primitives (API base, SSR/browser detection, cookie forwarding, store
 * resolution, CSRF) and re-export the three names — every existing call
 * site (`sellright().GET(...)`, `err instanceof SellRightError`,
 * `idempotency(key)`) keeps compiling unchanged.
 *
 * Types (`paths`/`components`) come from the package's own generated
 * schema, built from the API's OpenAPI document — regenerate via
 * `pnpm --filter @sellright/storefront-client run generate` (see that
 * package's `scripts/generate.mts`), not from a storefront-local script.
 */
import { isServer } from '@qwik.dev/core/build';
import {
	configureSellRightClient,
	SellRightError,
	idempotency,
	sellright as sellrightClient,
	unknownApiError,
	type paths,
	type components,
} from '@sellright/storefront-client';
import { apiBase, storeResolutionHeaders } from '~/utils/sellright';
import { sellrightRequestCookie } from '~/utils/sellright-request-context.server';

export type { paths, components };
export type Schemas = components['schemas'];
export { SellRightError, idempotency };

/** Same dual-cookie-name CSRF read the previous storefront-embedded client
 *  used: customer sessions on the real API set `sr_cust_csrf`; the isolated
 *  demo (no customer accounts) sets `sr_csrf` instead. */
function readCsrfCookie(): string | undefined {
	if (isServer || typeof document === 'undefined') return undefined;
	for (const name of ['sr_cust_csrf', 'sr_csrf']) {
		const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
		if (match) return decodeURIComponent(match[1]);
	}
	return undefined;
}

configureSellRightClient({
	baseUrl: () => (isServer ? apiBase() : ''),
	isServer: () => isServer,
	forwardCookie: () => (isServer ? sellrightRequestCookie.getStore() : undefined),
	// storeResolutionHeaders() already returns {} in the browser and picks
	// x-store-slug vs x-forwarded-host server-side — read whichever one it
	// set rather than re-deriving the same precedence rule here.
	storeSlug: () => storeResolutionHeaders()['x-store-slug'],
	forwardedHost: () => storeResolutionHeaders()['x-forwarded-host'],
	getCsrfToken: readCsrfCookie,
	timeoutMs: 8000,
});

/** Create a client for this request — same zero-argument shape (and same
 *  ALWAYS-THROW-ON-NON-2XX behavior) the previous storefront-embedded client
 *  had. `compat.ts`'s `sellright()` intentionally returns the raw,
 *  non-throwing openapi-fetch client (`{ data, error }`, its `request()`
 *  helper is the throwing wrapper) — every call site in this storefront was
 *  written against the old client's throwing contract
 *  (`const { data } = await sellright().POST(...)`, catching `SellRightError`),
 *  so this adds one more `onResponse` middleware on top of the package's own
 *  client that throws a `SellRightError` for any non-2xx response, same as
 *  the retired inline client did. */
export function sellright() {
	const client = sellrightClient();
	client.use({
		async onResponse({ response }) {
			if (response.ok) return response;
			const text = await response.clone().text();
			let body: unknown;
			try { body = JSON.parse(text); } catch { body = undefined; }
			throw unknownApiError(response.status, body);
		},
	});
	return client;
}
