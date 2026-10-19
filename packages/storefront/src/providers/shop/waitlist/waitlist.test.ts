import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestRestock } from './waitlist';

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('~/sellright/client', () => ({
	sellright: () => ({ POST: post }),
	SellRightError: class extends Error { constructor(public status: number) { super('API error'); } },
}));
afterEach(() => post.mockReset());

const input = { productId: '12345678-1234-4123-8123-123456789abc', email: 'a@b.co', turnstileToken: 'fresh', honeypot: '' };

describe('product restock provider', () => {
	it('sends exactly one request with product UUID, security token & honeypot', async () => {
		post.mockResolvedValue({ data: { ok: true } });
		expect(await requestRestock(input)).toEqual({ success: true });
		expect(post).toHaveBeenCalledExactlyOnceWith('/v1/shop/restock-request', { body: input });
	});
	it('does not report network or non-ok responses as successful signups', async () => {
		post.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ data: { ok: false } });
		expect((await requestRestock(input)).success).toBe(false);
		expect((await requestRestock(input)).success).toBe(false);
		expect(post).toHaveBeenCalledTimes(2);
	});
});
