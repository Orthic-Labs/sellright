// #425 step 2: the global stylesheet is inlined into every page again instead of linked as a render-blocking /build/style-*.css.
// bedbed29 made it an external <link>, which on a cold load blocks first paint on a second round trip; Damned's Vendure storefront
// measured exactly that change and rejected it (damned/docs/PERFORMANCE-2026-09-26.md: FCP 599 -> 1,332 ms; inline-all and a
// critical split were equal for FCP/LCP, 599 vs 605 ms). global.css is still emitted as a hashed file (the build-guards CSS gate
// checks it); this module swaps the manifest's stylesheet injection for a <style> with the file's content, read once per process.
// If a file cannot be read, that injection stays a <link> (the page is still styled, only slower).
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GlobalInjections } from '@qwik.dev/core/optimizer';

/** The client build dir next to the server bundle: server[-x]/... -> dist[-x] (entry.express.tsx resolves it the same way). */
export function clientDistDir(fromUrl: string): string | null {
	let dir = dirname(fileURLToPath(fromUrl));
	for (let i = 0; i < 4; i++) {
		const name = basename(dir);
		if (/^server/.test(name)) return join(dir, '..', name.replace(/^server/, 'dist'));
		dir = dirname(dir);
	}
	return null;
}

const isStylesheet = (i: GlobalInjections) => i.tag === 'link' && i.attributes?.rel === 'stylesheet' && typeof i.attributes.href === 'string';

/** Replaces each stylesheet <link> injection with an inline <style> of the same file, in the same position (same cascade order). */
export function inlineStylesheetInjections(injections: GlobalInjections[], read: (href: string) => string | null): GlobalInjections[] {
	return injections.map((i) => {
		if (!isStylesheet(i)) return i;
		const css = read(i.attributes!.href);
		return css === null ? i : { tag: 'style', location: i.location, attributes: { 'data-sr-global': '', dangerouslySetInnerHTML: css } };
	});
}

/** `/build/style-x.css` -> its content under `distDir`, or null (missing file, or an href outside /build/). */
export function readBuiltCss(distDir: string | null) {
	return (href: string): string | null => {
		if (!distDir || !/^\/build\/[\w.-]+\.css$/.test(href)) return null;
		try {
			// `</style` cannot occur in valid CSS outside strings; escaping it keeps a stray one from closing the element early.
			return readFileSync(join(distDir, href), 'utf8').replace(/<\/style/gi, '<\\/style');
		} catch {
			return null;
		}
	};
}
