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

// Extend RenderToStreamOptions to include platform with nonce
interface ExtendedRenderOptions extends RenderToStreamOptions {
	platform?: {
		res?: {
			locals?: {
				nonce?: string;
			};
		};
	};
}

export default function (opts: ExtendedRenderOptions) {
	const nonce = opts.platform?.res?.locals?.nonce;
	
	return renderToStream(<Root nonce={nonce} />, {
		manifest,
		...opts,
		base: extractBase,
		// Use container attributes to set attributes on the html tag.
		containerAttributes: {
			lang: 'en-us',
			...opts.containerAttributes,
		},
	});
}
