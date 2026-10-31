import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { precompressDir } from '~/platform/precompress';
import { precompressedStatic } from './precompressed-static';

let dir: string;
let server: Server;
let port: number;
const JS = `export const x = "${'hello world '.repeat(400)}";\n`;

const get = (path: string, enc?: string, method = 'GET') =>
	new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((res, rej) => {
		const r = request({ port, path, method, headers: enc ? { 'accept-encoding': enc } : {} }, (m) => {
			const c: Buffer[] = [];
			m.on('data', (d) => c.push(d));
			m.on('end', () => res({ status: m.statusCode ?? 0, headers: m.headers, body: Buffer.concat(c) }));
		});
		r.on('error', rej);
		r.end();
	});

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'pcs-'));
	const build = join(dir, 'build');
	mkdirSync(join(build, 'sub'), { recursive: true });
	writeFileSync(join(build, 'a.js'), JS);
	writeFileSync(join(build, 'sub', 'b.css'), 'a{color:red}'.repeat(300));
	writeFileSync(join(build, 'index.html'), '<p>'.repeat(500));
	writeFileSync(join(build, 'q-data.json'), '{"a":1}'.repeat(300));
	writeFileSync(join(build, 'tiny.js'), 'x');
	writeFileSync(join(dir, 'secret.js'), JS);
	await precompressDir(build);
	// hand-made siblings that must never be served
	writeFileSync(join(build, 'index.html.br'), 'nope');
	writeFileSync(join(dir, 'secret.js.br'), 'nope');
	const app = express();
	app.use('/build', precompressedStatic(build, { skip: (p) => /q-(data|loader)/.test(p) }));
	app.use('/build', (_q, r) => { r.status(299).send('fallthrough'); });
	server = app.listen(0);
	port = (server.address() as AddressInfo).port;
});
afterAll(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

describe('precompressedStatic', () => {
	it('prefers br, original content type, vary, immutable cache', async () => {
		const r = await get('/build/a.js', 'gzip, deflate, br');
		expect(r.status).toBe(200);
		expect(r.headers['content-encoding']).toBe('br');
		expect(r.headers['content-type']).toContain('javascript');
		expect(r.headers['vary']).toBe('Accept-Encoding');
		expect(r.headers['cache-control']).toBe('public, max-age=31536000, immutable');
		expect(brotliDecompressSync(r.body).toString()).toBe(JS);
	});
	it('falls back to gzip, then identity (express.static downstream)', async () => {
		const g = await get('/build/sub/b.css', 'gzip');
		expect(g.headers['content-encoding']).toBe('gzip');
		expect(g.headers['content-type']).toContain('text/css');
		expect(gunzipSync(g.body).toString()).toBe('a{color:red}'.repeat(300));
		expect((await get('/build/a.js')).status).toBe(299);
		expect((await get('/build/a.js', 'br;q=0, gzip;q=0')).status).toBe(299);
		expect((await get('/build/a.js', 'br;q=0, gzip')).headers['content-encoding']).toBe('gzip');
	});
	it('HEAD has headers and no body', async () => {
		const r = await get('/build/a.js', 'br', 'HEAD');
		expect(r.headers['content-encoding']).toBe('br');
		expect(r.body.length).toBe(0);
	});
	it('never html, q-data, files without sibling, or traversal', async () => {
		for (const p of ['/build/index.html', '/build/q-data.json', '/build/tiny.js', '/build/%2e%2e/secret.js', '/build/..%2fsecret.js', '/build/sub/../../secret.js', '/build/a.js%00']) {
			const r = await get(p, 'br, gzip');
			expect(r.headers['content-encoding'], p).toBeUndefined();
		}
	});
	it('conditional request returns 304', async () => {
		const first = await get('/build/a.js', 'br');
		const r = await new Promise<number>((res) => {
			request({ port, path: '/build/a.js', headers: { 'accept-encoding': 'br', 'if-none-match': String(first.headers.etag) } }, (m) => { m.resume(); res(m.statusCode ?? 0); }).end();
		});
		expect(r).toBe(304);
	});
});
