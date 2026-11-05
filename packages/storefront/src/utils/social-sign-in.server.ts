// Per-store social sign-in ids for THIS request's host, from the store's own admin Settings (GET /v1/shop/config
// `auth.googleClientId` / `auth.appleServicesId`). One answer drives both the CSP (entry.express.tsx) and the sign-in
// buttons (routes/sign-in), so they can never disagree. Fail closed: an unreachable API or a store without ids gives
// empty ids (no button, no origins). The build-time env path (config/google-signin.ts, config/apple-signin.ts) remains a
// fallback for pinned single-store deployments that set it.
//
// Ids are public by design. Each host's answer is kept for TTL_MS so the CSP step stays fast; a change in admin shows
// within that window; concurrent misses for one host share a single read (#362). This caches configuration only, never
// stock or prices.
import { googleSignInClientIdForHost } from '~/config/google-signin';
import { appleSignInClientIdForHost } from '~/config/apple-signin';
import { gatewaysFromShopConfig } from '~/platform/dns-prefetch';

export interface SocialSignInIds {
	google: string;
	apple: string;
}

export const TTL_MS = 60_000;
const TIMEOUT_MS = 1_500;
const NONE: SocialSignInIds = { google: '', apple: '' };
/** One host's public config facts: the sign-in ids and (#425) the enabled payment gateways (the head's dns-prefetch hints). */
interface StoreConfigFacts { ids: SocialSignInIds; gateways: string[] }
const cache = new Map<string, { at: number } & StoreConfigFacts>();
/** Misses in flight per key: concurrent requests for one host (a document and its assets) share one config read. */
const inflight = new Map<string, Promise<StoreConfigFacts>>();
/** Hosts are validated upstream, but the map is still bounded: the oldest entry goes first. */
export const MAX_ENTRIES = 256;

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
type ReadOptions = { storePin?: string; fetcher?: ConfigFetcher; now?: number };

/** The host's config facts from the shared per-host read (TTL_MS, one read in flight per host); empty on failure. */
async function storeConfigFacts(
	h: string,
	{ storePin = import.meta.env.VITE_SELLRIGHT_STORE_SLUG as string | undefined, fetcher = defaultFetcher, now = Date.now() }: ReadOptions,
): Promise<StoreConfigFacts | null> {
	const pin = clean(storePin);
	const key = pin ? `slug:${pin}` : `host:${h}`;
	if (!pin && !h) return null;
	const hit = cache.get(key);
	if (hit && now - hit.at < TTL_MS) return hit;
	let pending = inflight.get(key);
	if (!pending) {
		pending = (async () => {
			let read: StoreConfigFacts;
			try {
				const body = await fetcher(pin ? { 'x-store-slug': pin } : { 'x-forwarded-host': h });
				read = { ids: idsFromShopConfig(body), gateways: gatewaysFromShopConfig(body) };
			} catch {
				read = { ids: NONE, gateways: [] };
			}
			cache.delete(key);
			cache.set(key, { at: now, ...read });
			while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
			return read;
		})().finally(() => inflight.delete(key));
		inflight.set(key, pending);
	}
	return pending;
}

export async function socialSignInIdsForHost(host: string, opts: ReadOptions = {}): Promise<SocialSignInIds> {
	const h = (host || '').toLowerCase();
	const facts = await storeConfigFacts(h, opts);
	const ids = facts?.ids ?? NONE;
	const env = fallback(h);
	return { google: ids.google || env.google, apple: ids.apple || env.apple };
}

/** #425: the payment gateways this host's store enables (GET /v1/shop/config `gateways`), from the same cached read; [] on failure. */
export async function storeGatewaysForHost(host: string, opts: ReadOptions = {}): Promise<string[]> {
	return (await storeConfigFacts((host || '').toLowerCase(), opts))?.gateways ?? [];
}

function fallback(host: string): SocialSignInIds {
	return { google: googleSignInClientIdForHost(host), apple: appleSignInClientIdForHost(host) };
}

/** Test seam. */
export function clearSocialSignInCache(): void {
	cache.clear();
	inflight.clear();
}
