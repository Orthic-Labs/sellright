import { createContextId } from '@qwik.dev/core';
import { ENV_VARIABLES } from './env';
import { AppState } from './types';
import { theme, siteUrl } from './theme/theme.config';
export const APP_STATE = createContextId<AppState>('app_state');
/** The API's HttpOnly customer-session cookie (`CUST_COOKIE` in packages/api/src/auth/cookies.ts). The server-side
 *  guards (account layout, auth loader) can only see a signed-in shopper through THIS name; `authToken` was a leftover
 *  from the previous backend and made every full page load of /account/* bounce to /sign-in. */
export const AUTH_TOKEN = 'sr_cust';
export const COUNTRY_COOKIE = 'countryCode';
export const CUSTOMER_NOT_DEFINED_ID = 'CUSTOMER_NOT_DEFINED_ID';
export const IMAGE_RESOLUTIONS = [1000, 800, 600, 400];
export const HOMEPAGE_IMAGE = '/homepage.webp';
export const DEFAULT_METADATA_URL = `${siteUrl}/`;
export const DEFAULT_METADATA_TITLE = theme.storeName;
export const DEFAULT_METADATA_DESCRIPTION = theme.tagline;
export const DEFAULT_METADATA_IMAGE = `${siteUrl}/logo.svg`;
export const DEFAULT_LOCALE = 'en';
export const DEFAULT_CURRENCY = 'USD';
export const normalizeApiUrl = (value: string | undefined, fallback: string) => {
	const raw = (value || '').trim().replace(/`/g, '');
	const withoutTrailingSlash = raw.replace(/\/+$/g, '');
	const normalized = withoutTrailingSlash.replace(/\.+$/g, '');
	return normalized || fallback;
};

// Dev default is the SellRight API's own default port (packages/api/src/env.ts
// PORT default), not the old legacy-era localhost:3100 fallback.
export const SELLRIGHT_DEV_API_DEFAULT = 'http://localhost:3300';

/**
 * Pure value resolution — never throws. VITE_* vars are inlined by Vite at
 * BUILD time (not runtime-injectable), and Qwik's own build pipeline
 * evaluates this module while producing the SSR/SSG bundle (route/sitemap
 * generation) even for a plain verification build with no real domain
 * configured yet — throwing here would break `pnpm build` itself, not just a
 * misconfigured deploy. The actual "fail loud in production" enforcement
 * belongs at server STARTUP (entry.express.tsx's assertProdApiConfigured()),
 * which runs once, when the built server process actually boots to serve
 * traffic — not every time the bundler evaluates this module.
 */
export function resolveApiUrls(env: { prodUrl: string | undefined; devUrl: string | undefined; localUrl: string | undefined }) {
	return {
		devApi: normalizeApiUrl(env.devUrl, SELLRIGHT_DEV_API_DEFAULT),
		prodApi: normalizeApiUrl(env.prodUrl, SELLRIGHT_DEV_API_DEFAULT),
		localApi: normalizeApiUrl(env.localUrl, SELLRIGHT_DEV_API_DEFAULT),
	};
}

const { devApi, prodApi, localApi } = resolveApiUrls({
	prodUrl: ENV_VARIABLES.VITE_SELLRIGHT_PROD_URL,
	devUrl: ENV_VARIABLES.VITE_SELLRIGHT_DEV_URL,
	localUrl: ENV_VARIABLES.VITE_SELLRIGHT_LOCAL_URL,
});

export const DEV_API = devApi;
export const PROD_API = prodApi;
export const LOCAL_API = localApi;

/**
 * Call once at real server startup (entry.express.tsx) — NOT at module load.
 * Refuses to start (throws) when running as a production Node process
 * (NODE_ENV=production, a runtime check independent of Vite's build-time
 * import.meta.env.PROD) with NO API endpoint configured by any mechanism.
 *
 * WS-C (runtime storefront configuration, plan §1.9) introduced a SECOND,
 * now-primary way to configure the API endpoint: the runtime env var
 * `SELLRIGHT_API_URL`, read fresh per-request by utils/sellright.ts's
 * `apiBase()` — this is what lets one generic built image (no store/API URL
 * baked in) serve any store. `packages/storefront/Dockerfile`'s runtime image
 * is built with NO `VITE_SELLRIGHT_PROD_URL` build arg BY DESIGN (see that
 * file's header comment), so `PROD_API` is always the dev-port default for
 * that image — this assertion checking `PROD_API` alone would refuse to
 * start EVERY generic-image container unconditionally, regardless of
 * `SELLRIGHT_API_URL` being correctly set (deploy/compose.yaml always
 * defaults it to `http://api:3300`). Pass the runtime value in explicitly
 * (entry.express.tsx reads `process.env.SELLRIGHT_API_URL`) so a legacy
 * single-store build-time-configured deployment (PROD_API set, no
 * SELLRIGHT_API_URL) and the WS-C generic-image deployment (SELLRIGHT_API_URL
 * set, PROD_API left at its dev default) both correctly pass, and only a
 * build/deploy with genuinely NEITHER configured fails loud.
 */
export function assertProdApiConfigured(nodeEnv: string | undefined, runtimeApiUrl?: string): void {
	const hasRuntimeOverride = !!runtimeApiUrl?.trim();
	if (nodeEnv === 'production' && PROD_API === SELLRIGHT_DEV_API_DEFAULT && !hasRuntimeOverride) {
		throw new Error(
			'No API endpoint configured in production — set SELLRIGHT_API_URL (runtime, WS-C generic-image deployments) or bake in VITE_SELLRIGHT_PROD_URL at build time (legacy single-store deployments).',
		);
	}
}





