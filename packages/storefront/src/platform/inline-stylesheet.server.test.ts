import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { clientDistDir, inlineStylesheetInjections, readBuiltCss } from './inline-stylesheet.server';

const link = (href: string) => ({ tag: 'link', location: 'head' as const, attributes: { rel: 'stylesheet', href } });

describe('inline global stylesheet (#425 step 2)', () => {
	it('replaces the stylesheet link with an inline <style> in the same position', () => {
		const other = { tag: 'link', location: 'head' as const, attributes: { rel: 'modulepreload', href: '/build/q-a.js' } };
		const out = inlineStylesheetInjections([other, link('/build/style-A.css')], () => ':root{--x:1}');
		expect(out[0]).toBe(other);
		expect(out[1]).toEqual({ tag: 'style', location: 'head', attributes: { 'data-sr-global': '', dangerouslySetInnerHTML: ':root{--x:1}' } });
		// #427: the file stays linked at the end of <body> so client navigation keeps the page styled.
		expect(out[2]).toEqual({ tag: 'link', location: 'body', attributes: { rel: 'stylesheet', href: '/build/style-A.css', media: 'print', 'data-sr-global': '' } });
		expect(out).toHaveLength(3);
	});

	it('keeps the link when the file cannot be read', () => {
		const l = link('/build/style-A.css');
		expect(inlineStylesheetInjections([l], () => null)).toEqual([l]);
	});

	it('reads only /build/*.css under the dist dir and escapes a closing style tag', () => {
		const dist = mkdtempSync(join(tmpdir(), 'sr-css-'));
		mkdirSync(join(dist, 'build'));
		writeFileSync(join(dist, 'build/style-A.css'), 'a{content:"</style>"}');
		const read = readBuiltCss(dist);
		expect(read('/build/style-A.css')).toBe('a{content:"<\\/style>"}');
		expect(read('/build/missing.css')).toBeNull();
		expect(read('/../etc/passwd')).toBeNull();
		expect(readBuiltCss(null)('/build/style-A.css')).toBeNull();
	});

	it('maps server[-suffix]/ to dist[-suffix]/', () => {
		expect(clientDistDir(pathToFileURL('/app/server/entry.ssr.js').href)).toBe('/app/dist');
		expect(clientDistDir(pathToFileURL('/app/server-demo/assets/x.js').href)).toBe('/app/dist-demo');
		expect(clientDistDir(pathToFileURL('/app/other/x.js').href)).toBeNull();
	});
});
