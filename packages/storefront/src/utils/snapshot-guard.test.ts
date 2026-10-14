import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { snapshotShape } from './snapshot-guard';

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
	it('the entry answers a document shape with a no-store text 404 before every static handler and the canonical redirect', () => {
		const src = readFileSync(join(__dirname, '..', 'entry.express.tsx'), 'utf8');
		const guard = src.indexOf("snapshotShape(req.path) === 'document'");
		expect(guard).toBeGreaterThan(0);
		expect(guard).toBeLessThan(src.indexOf('app.use(`/build`'));
		expect(guard).toBeLessThan(src.indexOf('createCanonicalUrlMiddleware(parseCanonicalSections'));
	});
});
