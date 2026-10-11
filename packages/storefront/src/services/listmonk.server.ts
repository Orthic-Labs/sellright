/**
 * Listmonk compatibility for the legacy newsletter links `/newsletter/confirm/{uuid}` and
 * `/newsletter/unsubscribe/{uuid}` (mail already sent by a Listmonk install keeps working). SERVER-ONLY: the
 * `.server.ts` suffix keeps it out of the client bundle, so no Listmonk credential ever reaches the browser.
 *
 * Native SellRight newsletter signup (`/newsletter-signup`, `/subscriber/*`) stays the default path; this is only
 * reached when a store configures a Listmonk endpoint. Configuration is per store: `LISTMONK_STORES`, a JSON object
 * keyed by the store's public host (lowercase, no port), each value
 *   { baseUrl, user, token, listId, rootUrl?, brandName? }
 * The entry is looked up from the request's own host on every call. There is no process-wide fallback entry, so one
 * store's endpoint and credentials can never serve another store's request; a host with no entry answers 404.
 */

export interface ListmonkStoreConfig {
	baseUrl: string;
	user: string;
	token: string;
	listId: number;
	/** Value sent as the Origin header (Listmonk checks it against its root URL). Defaults to the store's https origin. */
	rootUrl: string;
	/** Optional display name used in the page copy; the pages are neutral without it. */
	brandName?: string;
}

export interface ListmonkSubscriber {
	id: number;
	uuid: string;
	email: string;
	listStatus: 'confirmed' | 'unconfirmed' | 'unsubscribed' | 'not_subscribed';
}

type RawSubscriber = {
	id: number;
	uuid: string;
	email: string;
	lists: { id: number; subscription_status: 'confirmed' | 'unconfirmed' | 'unsubscribed' }[];
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMEOUT_MS = 8000;

/** Request host without port, lowercase; '' when unusable. */
export function normalizeHost(host: string | undefined | null): string {
	if (!host) return '';
	return host.split(',')[0].trim().toLowerCase().replace(/:\d+$/, '');
}

/**
 * The Listmonk entry for this host, or null when the store has none (or the entry is unusable). Reads the env map
 * passed in, so a caller resolves it per request.
 */
export function resolveListmonkConfig(host: string | undefined | null, env: Record<string, string | undefined> = process.env): ListmonkStoreConfig | null {
	const key = normalizeHost(host);
	const raw = env.LISTMONK_STORES;
	if (!key || !raw) return null;
	let map: unknown;
	try {
		map = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!map || typeof map !== 'object' || !Object.prototype.hasOwnProperty.call(map, key)) return null;
	const e = (map as Record<string, Record<string, unknown>>)[key];
	if (!e || typeof e !== 'object') return null;
	const listId = Number(e.listId);
	if (typeof e.baseUrl !== 'string' || typeof e.user !== 'string' || typeof e.token !== 'string' || !e.baseUrl || !e.user || !e.token) return null;
	if (!Number.isInteger(listId) || listId <= 0) return null;
	try {
		const base = new URL(e.baseUrl);
		if (base.protocol !== 'http:' && base.protocol !== 'https:') return null;
	} catch {
		return null;
	}
	return {
		baseUrl: e.baseUrl.replace(/\/+$/, ''),
		user: e.user,
		token: e.token,
		listId,
		rootUrl: typeof e.rootUrl === 'string' && e.rootUrl ? e.rootUrl : `https://${key}`,
		brandName: typeof e.brandName === 'string' && e.brandName.trim() ? e.brandName.trim() : undefined,
	};
}

export class ListmonkClient {
	constructor(
		private config: ListmonkStoreConfig,
		private fetchImpl: typeof fetch = fetch,
	) {}

	private async request<T>(path: string, init?: RequestInit): Promise<T> {
		const res = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
			...init,
			headers: {
				Authorization: 'Basic ' + Buffer.from(`${this.config.user}:${this.config.token}`).toString('base64'),
				'Content-Type': 'application/json',
				Origin: this.config.rootUrl,
			},
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		if (!res.ok) throw new Error(`Listmonk ${init?.method || 'GET'} ${path} -> ${res.status}`);
		return res.json() as Promise<T>;
	}

	async lookupByUuid(uuid: string): Promise<ListmonkSubscriber | null> {
		if (!UUID_RE.test(uuid)) return null;
		const query = encodeURIComponent(`subscribers.uuid = '${uuid}'`);
		const data = await this.request<{ data: { results: RawSubscriber[] } }>(`/api/subscribers?query=${query}&per_page=1`);
		const raw = data.data.results[0];
		if (!raw) return null;
		const membership = raw.lists.find((l) => l.id === this.config.listId);
		return { id: raw.id, uuid: raw.uuid, email: raw.email, listStatus: membership ? membership.subscription_status : 'not_subscribed' };
	}

	/** This store's list only; other lists on the same Listmonk are never touched. */
	async unsubscribe(subscriberId: number): Promise<void> {
		await this.request('/api/subscribers/lists', {
			method: 'PUT',
			body: JSON.stringify({ ids: [subscriberId], action: 'unsubscribe', target_list_ids: [this.config.listId] }),
		});
	}

	async confirm(subscriberId: number): Promise<void> {
		await this.request('/api/subscribers/lists', {
			method: 'PUT',
			body: JSON.stringify({ ids: [subscriberId], action: 'add', target_list_ids: [this.config.listId], status: 'confirmed' }),
		});
	}
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const page = (title: string, heading: string, body: string): string =>
	`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title></head>` +
	`<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1.5rem"><h1>${esc(heading)}</h1>${body}<p><a href="/">Return home</a></p></body></html>`;

export type ListmonkLinkResult = { status: number; html: string };

/**
 * Handle one legacy link. `host` is the request's own host (resolved per call). Not configured: 404 and nothing is
 * contacted. Unknown or malformed id: 404. Listmonk unreachable or erroring: 502. Both actions are idempotent.
 */
export async function handleListmonkLink(
	action: 'confirm' | 'unsubscribe',
	opts: { host: string | undefined | null; uuid: string; env?: Record<string, string | undefined>; fetchImpl?: typeof fetch },
): Promise<ListmonkLinkResult> {
	const config = resolveListmonkConfig(opts.host, opts.env);
	if (!config) return { status: 404, html: page('Not found', 'Not found', '<p>This page does not exist.</p>') };
	const who = config.brandName ? ` ${config.brandName}` : '';
	const client = new ListmonkClient(config, opts.fetchImpl);
	try {
		const sub = await client.lookupByUuid(opts.uuid);
		if (!sub) {
			return { status: 404, html: page('Link not valid', 'Link not valid', '<p>We could not find a subscriber matching this link.</p>') };
		}
		const email = `<strong>${esc(sub.email)}</strong>`;
		if (action === 'confirm') {
			if (sub.listStatus !== 'confirmed') await client.confirm(sub.id);
			return { status: 200, html: page('Newsletter confirmed', sub.listStatus === 'confirmed' ? "You're already in" : 'Subscription confirmed', `<p>${email} is confirmed on our${who} newsletter.</p>`) };
		}
		if (sub.listStatus !== 'unsubscribed' && sub.listStatus !== 'not_subscribed') await client.unsubscribe(sub.id);
		return {
			status: 200,
			html: page('Unsubscribed', "You're unsubscribed", `<p>${email} is no longer on the${who} marketing list. You will still receive transactional emails such as order confirmations.</p>`),
		};
	} catch (err) {
		console.error(`[newsletter/${action}] listmonk error:`, err instanceof Error ? err.message : err);
		return { status: 502, html: page('Temporarily unavailable', 'Temporarily unavailable', '<p>Our newsletter system is unreachable. Please try again in a minute.</p>') };
	}
}
