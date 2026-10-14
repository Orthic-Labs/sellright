import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NO_STORE_CACHE_CONTROL } from '~/config/route-cache-policy';
import { snapshotGuard, snapshotShape, type GuardRes } from './snapshot-guard';

describe('snapshotShape', () => {
	it('document shapes, decoded and normalised', () => {
		for (const p of ['/shop/index.html', '/shop/index%2ehtml', '/shop/index.htm', '/x/index.html.gz', '/a/../shop/index.html', '/shop/index.html/', '/shop/index.html/.', '/%E0%A4%A']) {
			expect(snapshotShape(p), p).toBe('document');
		}
	});
	it('route data passes as data; pages and assets are neither', () => {
		expect(snapshotShape('/shop/tee/q-loader-abc.123.json')).toBe('data');
		expect(snapshotShape('/shop/q-data.json')).toBe('data');
		for (const p of ['/', '/shop/', '/shop/tee/', '/sitemap.xml', '/robots.txt', '/build/q-abc.js', '/fonts/a.woff2']) expect(snapshotShape(p), p).toBeNull();
	});
	it('the middleware: a document is a no-store text 404 and nothing downstream runs; other requests continue untouched', () => {
		const run = (path: string) => {
			const out = { status: 0, headers: {} as Record<string, string>, body: null as string | null, next: 0 };
			const res: GuardRes = {
				status(code) { out.status = code; return res; },
				set(h) { Object.assign(out.headers, h); return res; },
				send(b) { out.body = b; return res; },
			};
			snapshotGuard({ path }, res, () => { out.next++; });
			return out;
		};
		for (const p of ['/shop/index.html', '/shop/index%2ehtml']) {
			const r = run(p);
			expect(r).toEqual({ status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': NO_STORE_CACHE_CONTROL }, body: 'Not found', next: 0 });
			expect(NO_STORE_CACHE_CONTROL).toMatch(/no-store/);
		}
		for (const p of ['/shop/', '/shop/tee/q-loader-abc.json', '/build/q-a.js', '/fonts/a.woff2']) {
			expect(run(p)).toEqual({ status: 0, headers: {}, body: null, next: 1 });
		}
	});

	it('the entry mounts the guard before every static handler and the canonical redirect', () => {
		const src = readFileSync(join(__dirname, '..', 'entry.express.tsx'), 'utf8');
		const guard = src.indexOf('app.use(snapshotGuard);');
		expect(guard).toBeGreaterThan(0);
		expect(guard).toBeLessThan(src.indexOf('app.use(`/build`'));
		expect(guard).toBeLessThan(src.indexOf('createCanonicalUrlMiddleware(parseCanonicalSections'));
	});
});
