import { createContextId } from '@qwik.dev/core';
import { ENV_VARIABLES } from './env';
import { AppState } from './types';
import { theme, siteUrl } from './theme/theme.config';
export const APP_STATE = createContextId<AppState>('app_state');
export const AUTH_TOKEN = 'authToken';
export const COUNTRY_COOKIE = 'countryCode';
export const CUSTOMER_NOT_DEFINED_ID = 'CUSTOMER_NOT_DEFINED_ID';
export const HEADER_AUTH_TOKEN_KEY = 'vendure-auth-token';
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
// PORT default), not the old Vendure-era localhost:3100 fallback.
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
 * import.meta.env.PROD) with PROD_API still on the dev-port default, i.e.
 * VITE_SELLRIGHT_PROD_URL was never configured for this build.
 */
export function assertProdApiConfigured(nodeEnv: string | undefined): void {
	if (nodeEnv === 'production' && PROD_API === SELLRIGHT_DEV_API_DEFAULT) {
		throw new Error('VITE_SELLRIGHT_PROD_URL is required in production — refusing to serve with a dev API URL baked into the build.');
	}
}





