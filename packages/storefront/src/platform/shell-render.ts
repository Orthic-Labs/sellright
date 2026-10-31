// ADR-0001 (lane S2): server-only switch for the stock- and price-free shell. On with SHELL_CACHE=1 (route-cache-policy.ts, lane S3):
// shell loaders redact their values and the page reads them in the browser (platform/live-values.ts). Off (default): unchanged.
import { isServer } from '@qwik.dev/core/build';
import { NO_STORE_CACHE_CONTROL, shellCacheEnabled } from '~/config/route-cache-policy';
import { shellRenderContext } from './shell-render-context.server';

/** True when this render may be stored as a shared shell: loaders must return no price and no stock. Server-side only: the switch is
 *  on AND the request middleware marked this request a shell render (a dynamic or SHELL_CACHE_EXCLUDE route renders as switch off).
 *  Outside a request context (unit tests, scripts) it follows the switch alone. */
export const shellRender = (): boolean => {
	if (!isServer || !shellCacheEnabled()) return false;
	const marked = shellRenderContext.getStore();
	return marked === undefined ? true : marked;
};

/** A live-values read (server$) is never stored: browser, edge or any shared cache. */
export function noStore(ev: { headers: { set(name: string, value: string): void } } | undefined): void {
	try {
		ev?.headers.set('Cache-Control', NO_STORE_CACHE_CONTROL);
	} catch {
		// headers already sent: the request class (POST, server$) is no-store anyway
	}
}
