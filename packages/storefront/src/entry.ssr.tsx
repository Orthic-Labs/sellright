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

	return renderToStream(<Root nonce={nonce} />, {
		manifest,
		...opts,
		base: extractBase,
		// Use container attributes to set attributes on the html tag.
		containerAttributes: {
			lang: 'en-us',
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
}
