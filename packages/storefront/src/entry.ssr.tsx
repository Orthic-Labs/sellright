/**
 * WHAT IS THIS FILE?
 *
 * SSR entry point, in all cases the application is rendered outside the browser, this
 * entry point will be the common one.
 *
 * - Server (express, etc.)
 * - pnpm start
 * - pnpm preview
 * - pnpm build
 *
 */
import { renderToStream, RenderToStreamOptions } from '@qwik.dev/core/server';
import { manifest } from '@qwik-client-manifest';
import Root from './root';
import { extractBase } from './utils/i18n';
import { identityFromStaticTheme } from './theme/theme.config';
import { ipCountry } from './platform/head-analytics';
import { headOrderWriter } from './platform/head-order';
import { clientDistDir, inlineStylesheetInjections, readBuiltCss } from './platform/inline-stylesheet.server';
import { loadWarmScript } from './platform/warm-graph.server';
import { earlyReadsStream } from './platform/early-reads.server';
import { deferredLoaderInjections } from './platform/deferred-loader.server';

// #425 step 2: the global stylesheet inline (platform/inline-stylesheet.server.ts), resolved once per manifest object.
const distDir = import.meta.env.PROD ? clientDistDir(import.meta.url) : null;
const readCss = readBuiltCss(distDir);
// #425 step 3: the targeted warm graph that replaces Qwik's preloader (platform/warm-graph.server.ts), built once per process.
const warm = loadWarmScript(distDir);
const inlined = new WeakMap<object, typeof manifest>();
function withInlineStylesheet(m: typeof manifest): typeof manifest {
	if (!m?.injections) return m;
	let r = inlined.get(m);
	if (!r) inlined.set(m, (r = { ...m, injections: inlineStylesheetInjections(m.injections, readCss) }));
	return r;
}

// Extend RenderToStreamOptions to include the request headers this app's
// render() actually receives.
//
// Two dead ends first: `opts.platform.res.locals.nonce` (the framework's
// node-server middleware builds its own `platform` as { ssr, incomingMessage,
// node } and only merges a caller `opts.platform` when isDev — a production
// request never sees `res`); and `opts.platform` itself, which by the time
// `requestHandler` invokes this render function has been stripped down to
// `{ base, stream, serverData, containerAttributes }` — no `platform` key at
// all survives the trip. `opts.serverData.requestHeaders` (a plain object
// mirroring the original request's headers) does survive, so
// entry.express.tsx stamps the nonce onto a custom request header
// (x-qwik-nonce) instead of a `req`/`res` property, and we read it back here.
interface ExtendedRenderOptions extends RenderToStreamOptions {
	serverData?: RenderToStreamOptions['serverData'] & {
		requestHeaders?: Record<string, string>;
	};
}

export default function (opts: ExtendedRenderOptions) {
	const nonce = opts.serverData?.requestHeaders?.['x-qwik-nonce'];
	// #375: the visitor's country from Cloudflare, for the GTM loader's first-visit user data. A shell render (ADR-0001, may be
	// edge-cached) never sees cf-ipcountry or a nonce: the express layer strips both, so country and nonce are undefined there.
	const country = ipCountry(opts.serverData?.requestHeaders?.['cf-ipcountry']);

	// F2: the render-blocking stylesheet first in <head>, Qwik's speculative preloads after it (platform/head-order.ts).
	// #415: the parse-time live reads script, first in <head> (platform/early-reads.server.ts).
	const stream = headOrderWriter(earlyReadsStream(opts.stream, opts.serverData?.url, nonce));
	const base = withInlineStylesheet((opts.manifest as typeof manifest | undefined) ?? manifest);
	// Per request: the warm script carries this render's nonce (a shell render has none; the express layer hashes it instead).
	// #425: Qwik's loader starts after the first frame (platform/deferred-loader.server.ts); the framework's own loader tag is off below.
	const loaderSrc = base?.qwikLoader ? `/build/${base.qwikLoader}` : null;
	const extra = [
		...(loaderSrc ? deferredLoaderInjections(loaderSrc, nonce) : []),
		...(warm ? [{ tag: 'script', location: 'head' as const, attributes: { ...(nonce ? { nonce } : {}), dangerouslySetInnerHTML: warm } }] : []),
	];
	const renderManifest = base && extra.length ? { ...base, injections: [...(base.injections ?? []), ...extra] } : base;
	const result = renderToStream(<Root nonce={nonce} country={country} />, {
		...opts,
		manifest: renderManifest,
		// #425 step 3: no speculative preloader (115-271 script requests per page); the warm graph above fetches what is needed.
		preloader: false,
		...(loaderSrc ? { qwikLoader: 'never' as const } : {}),
		stream,
		base: extractBase,
		// Use container attributes to set attributes on the html tag.
		//
		// The real per-request store identity/locale (WS-C — resolved by
		// routes/layout.tsx's useStoreIdentityLoader) isn't available yet here:
		// containerAttributes open the <html> tag before any routeLoader$ runs,
		// and awaiting one here would add a blocking round-trip in front of
		// every byte of the stream. So this uses the build-time static theme's
		// locale (theme.config.ts VITE_STORE_LOCALE, single source of truth —
		// see constants.ts DEFAULT_LOCALE for the same fallback used
		// elsewhere) instead of a bare hardcoded string. `Head` (components/
		// head/head.tsx) reconciles `document.documentElement.lang` against the
		// resolved identity once it's available, for stores whose runtime
		// locale differs from the static build default.
		containerAttributes: {
			lang: identityFromStaticTheme().locale,
			...opts.containerAttributes,
		},
		// The CORE Qwik bootstrap-loader <script> (and its own preload
		// links) are written by the framework itself, not by application
		// JSX — it reads `opts.serverData.nonce` directly
		// (@qwik.dev/core/dist/server.mjs). Passing the nonce only as a
		// <Root nonce> prop (above) covers this app's OWN inline scripts
		// (see root.tsx/head.tsx) but leaves the framework's bootstrap
		// script nonce-less, so the browser's CSP silently drops it and no
		// QRL ever resumes. Both are required.
		serverData: {
			...opts.serverData,
			nonce,
		},
	});
	return result.finally(() => stream.flush());
}
