import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createErrorPathLog, redactPath, referrerFor, shouldLog } from './error-path-log';

describe('redactPath', () => {
	it('drops the query string and fragment', () => {
		expect(redactPath('/search?q=secret%40mail.com')).toBe('/search');
		expect(redactPath('/shop/knives#top')).toBe('/shop/knives');
	});

	it('redacts the segment after an order, confirmation, subscriber or address route', () => {
		expect(redactPath('/orders/DD30330')).toBe('/orders/:redacted');
		expect(redactPath('/checkout/confirmation/RH10001/')).toBe('/checkout/confirmation/:redacted/');
		expect(redactPath('/subscriber/confirm/abc')).toBe('/subscriber/confirm/:redacted');
		expect(redactPath('/newsletter/unsubscribe/42')).toBe('/newsletter/unsubscribe/:redacted');
		expect(redactPath('/account/address-book/7')).toBe('/account/address-book/:redacted');
	});

	it('redacts UUIDs and long opaque tokens anywhere, but keeps word slugs', () => {
		expect(redactPath('/x/048dc9af-72c6-47a7-906b-8f12685ab75f')).toBe('/x/:redacted');
		expect(redactPath('/r/aB3dE5fG7hI9jK1lM3nO5p')).toBe('/r/:redacted');
		expect(redactPath('/x/9f86d081884c7d659a2feaa0c55ad015')).toBe('/x/:redacted');
		expect(redactPath('/blog/dead-faced-bad-bead-cafe/')).toBe('/blog/dead-faced-bad-bead-cafe/');
		expect(redactPath('/products/poison-bead-2024-limited-edition/')).toBe('/products/poison-bead-2024-limited-edition/');
		expect(redactPath('/wp-login.php')).toBe('/wp-login.php');
		expect(redactPath('/u/someone@mail.com/x')).toBe('/u/:redacted/x');
		expect(redactPath('/u/someone%40mail.com')).toBe('/u/:redacted');
	});

	it('caps the length', () => {
		expect(redactPath('/' + 'a-'.repeat(200)).length).toBe(200);
	});
});

describe('referrerFor', () => {
	it('gives the redacted path for the same host and only the host for another site', () => {
		expect(referrerFor('https://damneddesigns.com/blog/post?utm=x', 'damneddesigns.com')).toBe('/blog/post');
		expect(referrerFor('https://DamnedDesigns.com/orders/DD1', 'damneddesigns.com')).toBe('/orders/:redacted');
		expect(referrerFor('https://www.google.com/search?q=knife', 'damneddesigns.com')).toBe('www.google.com');
		expect(referrerFor(undefined, 'damneddesigns.com')).toBeUndefined();
		expect(referrerFor('not a url', 'damneddesigns.com')).toBeUndefined();
	});
});

describe('shouldLog', () => {
	it('logs 404 and 5xx only', () => {
		expect([200, 301, 304, 400, 403, 404, 410, 500, 503].filter(shouldLog)).toEqual([404, 500, 503]);
	});
});

describe('createErrorPathLog', () => {
	const run = (mw: ReturnType<typeof createErrorPathLog>, status: number, url = '/missing?x=1') => {
		const res = Object.assign(new EventEmitter(), { statusCode: status });
		const req = { method: 'GET', originalUrl: url, url, headers: { host: 'shop.test', referer: 'https://shop.test/blog/a', 'user-agent': 'Mozilla/5.0 test' } };
		let nexted = false;
		mw(req as never, res as never, () => { nexted = true; });
		res.emit('finish');
		return nexted;
	};

	it('writes one line for a 404 with path, referrer and no query, and always calls next', () => {
		const lines: string[] = [];
		const mw = createErrorPathLog({ write: (l) => lines.push(l), now: () => 1_000 });
		expect(run(mw, 404)).toBe(true);
		expect(run(mw, 200)).toBe(true);
		expect(lines).toHaveLength(1);
		const rec = JSON.parse(lines[0].replace('[http-error] ', ''));
		expect(rec).toMatchObject({ status: 404, method: 'GET', path: '/missing', ref: '/blog/a', ua: 'Mozilla/5.0 test' });
		expect(lines[0]).not.toContain('x=1');
	});

	it('caps lines per minute and reports the dropped count when the window rolls', () => {
		const lines: string[] = [];
		let t = 0;
		const mw = createErrorPathLog({ perMinute: 2, write: (l) => lines.push(l), now: () => t });
		for (let i = 0; i < 5; i++) run(mw, 404);
		expect(lines).toHaveLength(2);
		t = 60_000;
		run(mw, 500);
		expect(lines).toHaveLength(4);
		expect(JSON.parse(lines[2].replace('[http-error] ', ''))).toMatchObject({ dropped: 3 });
		expect(JSON.parse(lines[3].replace('[http-error] ', ''))).toMatchObject({ status: 500 });
	});
});
