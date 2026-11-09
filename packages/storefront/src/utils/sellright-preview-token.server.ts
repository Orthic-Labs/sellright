/**
 * Server-only: the store preview token of the INCOMING request, so every server-side call to /v1/shop/* can forward it as
 * `x-preview-token` (the API enforces the publish/preview gate on every shop route and accepts the token from that header,
 * the preview_token query or the sr_preview_token cookie). Sources, in the order layout.tsx reads them: the `preview_token`
 * query parameter, then the `sr_preview_token` cookie. A request with neither has no token and sends no header, so ordinary
 * (and edge-cached shell) requests are unchanged; shell requests have Cookie and x-preview-token stripped before this runs
 * (config/route-cache-policy.ts) and a preview query is never classed `shell`. `.server.ts` is stripped from the client bundle.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export const PREVIEW_TOKEN_HEADER = 'x-preview-token';
const PREVIEW_QUERY_PARAM = 'preview_token';
const PREVIEW_COOKIE = 'sr_preview_token';
/** A token is an opaque URL-safe string; anything else is dropped rather than put into a header. */
const TOKEN_SHAPE = /^[A-Za-z0-9._~-]{1,512}$/;

export const sellrightPreviewToken = new AsyncLocalStorage<string | undefined>();

function clean(raw: string | null | undefined): string | undefined {
	return raw && TOKEN_SHAPE.test(raw) ? raw : undefined;
}

function fromCookie(cookieHeader: string | undefined): string | undefined {
	if (!cookieHeader) return undefined;
	for (const part of cookieHeader.split(';')) {
		const eq = part.indexOf('=');
		if (eq < 0 || part.slice(0, eq).trim() !== PREVIEW_COOKIE) continue;
		let value = part.slice(eq + 1).trim();
		try { value = decodeURIComponent(value); } catch { return undefined; }
		return clean(value);
	}
	return undefined;
}

/** The preview token of one request (query wins over cookie), or undefined. `url` is the path plus query. */
export function resolvePreviewToken(req: { url: string; cookie?: string | string[] }): string | undefined {
	const q = req.url.indexOf('?');
	if (q >= 0) {
		const fromQuery = clean(new URLSearchParams(req.url.slice(q + 1).split('#')[0]).get(PREVIEW_QUERY_PARAM));
		if (fromQuery) return fromQuery;
	}
	return fromCookie(Array.isArray(req.cookie) ? req.cookie.join('; ') : req.cookie);
}

/** `{ 'x-preview-token': token }` for the current request, or `{}` (no header at all) when it carries none. */
export function previewTokenHeaders(): Record<string, string> {
	const token = sellrightPreviewToken.getStore();
	return token ? { [PREVIEW_TOKEN_HEADER]: token } : {};
}
