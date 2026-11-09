import { describe, expect, it } from 'vitest';
import { previewTokenHeaders, resolvePreviewToken, sellrightPreviewToken } from './sellright-preview-token.server';

describe('preview token forwarded to the API', () => {
	it('reads the query token, which wins over the cookie', () => {
		expect(resolvePreviewToken({ url: '/shop?preview_token=abc123', cookie: 'sr_preview_token=zzz' })).toBe('abc123');
	});

	it('falls back to the sr_preview_token cookie among other cookies', () => {
		expect(resolvePreviewToken({ url: '/shop', cookie: 'a=1; sr_preview_token=tok-en_9; b=2' })).toBe('tok-en_9');
	});

	it('returns undefined with no token, a different cookie, or a malformed value', () => {
		expect(resolvePreviewToken({ url: '/shop?x=1' })).toBeUndefined();
		expect(resolvePreviewToken({ url: '/', cookie: 'sr_session=abc' })).toBeUndefined();
		expect(resolvePreviewToken({ url: '/?preview_token=a%0d%0ab' })).toBeUndefined();
		expect(resolvePreviewToken({ url: '/', cookie: 'sr_preview_token=a b' })).toBeUndefined();
		expect(resolvePreviewToken({ url: '/', cookie: 'sr_preview_token=%E0%A4%A' })).toBeUndefined();
	});

	it('adds x-preview-token only inside a request that carries one', async () => {
		expect(previewTokenHeaders()).toEqual({});
		await sellrightPreviewToken.run('abc123', async () => expect(previewTokenHeaders()).toEqual({ 'x-preview-token': 'abc123' }));
		await sellrightPreviewToken.run(undefined, async () => expect(previewTokenHeaders()).toEqual({}));
	});
});
