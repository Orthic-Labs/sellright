/**
 * Listmonk compatibility for the legacy newsletter links `/newsletter/confirm/{uuid}` and
 * `/newsletter/unsubscribe/{uuid}` (mail already sent by the previous Listmonk install keeps working). SERVER-ONLY.
 *
 * The Listmonk call itself is made by the SellRight API (`POST /v1/shop/newsletter/legacy/{action}/{uuid}`, api
 * `marketing/listmonk-legacy-links.ts`), using the store's own connection (`store.config.listmonk`, the one the admin
 * Marketing screen configures). The storefront holds no Listmonk URL or credential and needs no env for this: it
 * renders the pages and forwards the validated request host so the API resolves the right store. The store is chosen
 * from a VALIDATED host (`newsletterRequestHost`: the connection's Host header, or X-Forwarded-Host only when the
 * deployment declares a trusted proxy with `SELLRIGHT_TRUST_FORWARDED_HOST=1`); a deployment pinned to one store
 * (`VITE_SELLRIGHT_STORE_SLUG`) sends that slug instead. A store with no Listmonk connection answers 404.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMEOUT_MS = 8000;

/** Request host without port, lowercase; '' when unusable. */
export function normalizeHost(host: string | undefined | null): string {
	if (!host) return '';
	const first = host.split(',')[0];
	// Control characters (a header-splitting attempt) are never trimmed away: any code point below 0x20, or 0x7f, is unusable.
	if ([...first].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) return '';
	const h = first.trim().toLowerCase().replace(/:\d+$/, '');
	return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(h) ? h : '';
}

/**
 * The host that selects a store's Listmonk entry. Never taken from a client-controlled header on its own: the
 * connection's Host is used unless the deployment declares a trusted proxy (`SELLRIGHT_TRUST_FORWARDED_HOST=1`, set
 * only when the proxy overwrites X-Forwarded-Host), in which case X-Forwarded-Host wins. '' when unusable.
 */
export function newsletterRequestHost(
	headers: { host?: string | null; forwardedHost?: string | null },
	env: Record<string, string | undefined> = process.env,
): string {
	const trusted = env.SELLRIGHT_TRUST_FORWARDED_HOST === '1';
	return normalizeHost(trusted && headers.forwardedHost ? headers.forwardedHost : headers.host);
}

/** The store pin in this env map (`VITE_SELLRIGHT_STORE_SLUG`), or ''. */
function storePinFrom(env: Record<string, string | undefined>): string {
	return (env.VITE_SELLRIGHT_STORE_SLUG || '').trim();
}

/** The deployment's store pin for the routes: the build-time value the rest of the storefront uses, else the runtime one. */
export function deploymentStorePin(): string {
	return ((import.meta.env.VITE_SELLRIGHT_STORE_SLUG as string | undefined) || storePinFrom(process.env)).trim();
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const page = (title: string, heading: string, body: string): string =>
	`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title></head>` +
	`<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1.5rem"><h1>${esc(heading)}</h1>${body}<p><a href="/">Return home</a></p></body></html>`;

export type ListmonkLinkResult = { status: number; html: string };

const notFound = (): ListmonkLinkResult => ({ status: 404, html: page('Not found', 'Not found', '<p>This page does not exist.</p>') });


/**
 * GET: the confirmation page for one legacy link. Mutates nothing and contacts no upstream (mail scanners and link
 * prefetchers issue GETs); the button submits a same-origin POST to the same path. Malformed id: 404. Whether the
 * store has a Listmonk connection is only known to the API, so that is answered by the POST.
 */
export function renderListmonkConfirmPage(action: 'confirm' | 'unsubscribe', opts: { uuid: string }): ListmonkLinkResult {
	if (!UUID_RE.test(opts.uuid)) return notFound();
	const [title, heading, text, button] =
		action === 'confirm'
			? ['Confirm subscription', 'Confirm your subscription', 'Confirm that you want to receive our newsletter.', 'Confirm subscription']
			: ['Unsubscribe', 'Unsubscribe from the newsletter', 'Confirm that you want to stop receiving our marketing newsletter.', 'Unsubscribe'];
	const form = `<form method="post" action="/newsletter/${action}/${esc(opts.uuid)}"><button type="submit" style="padding:.6rem 1.2rem;font-size:1rem">${esc(button)}</button></form>`;
	return { status: 200, html: page(title, heading, `<p>${esc(text)}</p>${form}`) };
}

/** POST guard: the Origin header must be present and name the validated host (the framework's own form-POST origin check
 *  also runs; this one fails closed when Origin is absent). */
export function isSameOriginPost(origin: string | null | undefined, host: string | undefined | null): boolean {
	if (!origin || !host) return false;
	try {
		return normalizeHost(new URL(origin).host) === normalizeHost(host);
	} catch {
		return false;
	}
}

type LegacyApiResult = 'confirmed' | 'already_confirmed' | 'unsubscribed' | 'already_unsubscribed';

/**
 * POST: perform one legacy link through the SellRight API. `host` is the validated host (resolved per call), `apiBase`
 * the API origin. Unusable host, malformed id, unknown subscriber or a store with no Listmonk connection: 404. API or
 * Listmonk unreachable: 502. Both actions are idempotent.
 */
export async function handleListmonkLink(
	action: 'confirm' | 'unsubscribe',
	opts: { host: string | undefined | null; uuid: string; apiBase: string; storePin?: string; fetchImpl?: typeof fetch },
): Promise<ListmonkLinkResult> {
	const host = normalizeHost(opts.host);
	if (!host || !UUID_RE.test(opts.uuid)) return notFound();
	const invalid = (): ListmonkLinkResult => ({ status: 404, html: page('Link not valid', 'Link not valid', '<p>We could not find a subscriber matching this link.</p>') });
	try {
		const res = await (opts.fetchImpl ?? fetch)(`${opts.apiBase.replace(/\/+$/, '')}/v1/shop/newsletter/legacy/${action}/${opts.uuid}`, {
			method: 'POST',
			// The pin wins, exactly as `storeResolutionHeaders()` does for every other storefront call.
			headers: opts.storePin ? { 'x-store-slug': opts.storePin } : { 'x-forwarded-host': host },
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		if (res.status === 404) return invalid();
		if (!res.ok) throw new Error(`API ${res.status}`);
		const body = (await res.json()) as { result?: LegacyApiResult; email?: string };
		if (typeof body.email !== 'string' || !body.result) throw new Error('unexpected API response');
		const email = `<strong>${esc(body.email)}</strong>`;
		switch (body.result) {
			case 'confirmed':
			case 'already_confirmed':
				return { status: 200, html: page('Newsletter confirmed', body.result === 'already_confirmed' ? "You're already in" : 'Subscription confirmed', `<p>${email} is confirmed on our newsletter.</p>`) };
			case 'unsubscribed':
			case 'already_unsubscribed':
				return {
					status: 200,
					html: page('Unsubscribed', action === 'confirm' ? 'Not subscribed' : "You're unsubscribed",
						action === 'confirm'
							? `<p>${email} has unsubscribed from our marketing list. Sign up again from our website to resubscribe.</p>`
							: `<p>${email} is no longer on the marketing list. You will still receive transactional emails such as order confirmations.</p>`),
				};
			default:
				throw new Error('unexpected API result');
		}
	} catch (err) {
		console.error(`[newsletter/${action}] newsletter API error:`, err instanceof Error ? err.message : err);
		return { status: 502, html: page('Temporarily unavailable', 'Temporarily unavailable', '<p>Our newsletter system is unreachable. Please try again in a minute.</p>') };
	}
}
