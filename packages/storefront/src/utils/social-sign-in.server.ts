// Per-store social sign-in ids for THIS request's host, from the store's own admin Settings (GET /v1/shop/config
// `auth.googleClientId` / `auth.appleServicesId`). One answer drives both the CSP (entry.express.tsx) and the sign-in
// buttons (routes/sign-in), so they can never disagree. Fail closed: an unreachable API or a store without ids gives
// empty ids (no button, no origins). The build-time env path (config/google-signin.ts, config/apple-signin.ts) remains a
// fallback for pinned single-store deployments that set it.
//
// Ids are public by design. Each host's answer is kept for TTL_MS so the CSP step stays fast; a change in admin shows
// within that window. This caches configuration only, never stock or prices.
import { googleSignInClientIdForHost } from '~/config/google-signin';
import { appleSignInClientIdForHost } from '~/config/apple-signin';

export interface SocialSignInIds {
	google: string;
	apple: string;
}

export const TTL_MS = 60_000;
const TIMEOUT_MS = 1_500;
const NONE: SocialSignInIds = { google: '', apple: '' };
const cache = new Map<string, { at: number; ids: SocialSignInIds }>();

type ConfigFetcher = (headers: Record<string, string>) => Promise<unknown>;

const defaultFetcher: ConfigFetcher = async (headers) => {
	const base = (process.env.SELLRIGHT_API_URL || '').replace(/\/+$/, '');
	if (!base) return null;
	const res = await fetch(`${base}/v1/shop/config`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
	return res.ok ? res.json() : null;
};

const clean = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** The public ids the store's config advertises, or empty strings. Pure: exported for tests. */
export function idsFromShopConfig(body: unknown): SocialSignInIds {
	const auth = (body as { auth?: { googleClientId?: unknown; appleServicesId?: unknown } } | null)?.auth;
	return { google: clean(auth?.googleClientId), apple: clean(auth?.appleServicesId) };
}

/**
 * Ids for this host: the store's admin Settings first, else the env fallback for that host. `storePin` is the build's
 * VITE_SELLRIGHT_STORE_SLUG (a pinned process always asks for its own store).
 */
export async function socialSignInIdsForHost(
	host: string,
	{ storePin = import.meta.env.VITE_SELLRIGHT_STORE_SLUG as string | undefined, fetcher = defaultFetcher, now = Date.now() }: { storePin?: string; fetcher?: ConfigFetcher; now?: number } = {},
): Promise<SocialSignInIds> {
	const h = (host || '').toLowerCase();
	const pin = clean(storePin);
	const key = pin ? `slug:${pin}` : `host:${h}`;
	if (!pin && !h) return fallback(h);
	const hit = cache.get(key);
	let ids: SocialSignInIds;
	if (hit && now - hit.at < TTL_MS) ids = hit.ids;
	else {
		try {
			ids = idsFromShopConfig(await fetcher(pin ? { 'x-store-slug': pin } : { 'x-forwarded-host': h }));
		} catch {
			ids = NONE;
		}
		cache.set(key, { at: now, ids });
	}
	const env = fallback(h);
	return { google: ids.google || env.google, apple: ids.apple || env.apple };
}

function fallback(host: string): SocialSignInIds {
	return { google: googleSignInClientIdForHost(host), apple: appleSignInClientIdForHost(host) };
}

/** Test seam. */
export function clearSocialSignInCache(): void {
	cache.clear();
}
