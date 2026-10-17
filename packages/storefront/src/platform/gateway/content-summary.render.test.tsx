import { describe, expect, it } from 'vitest';
import { CONTENT_DATA } from './index';
import { enter } from './gate';

const base = {
	identity: { storeName: 'Store', legalName: 'Store', tagline: '', supportEmail: 'support@example.com', logoText: 'Store', logoImageUrl: null, siteOrigin: 'https://store.example', social: {} },
	pageKey: 'reviews',
	pathname: '/reviews/',
};
const summary = { score: '4.7', count: '298+', reviews: [{ text: 'Customer review.', name: 'Customer' }] };
const content = (data: unknown) => enter('content-summary', { data: CONTENT_DATA }, data as Record<string, unknown>).props;

describe('content review summary gateway contract', () => {
	it('preserves absent and nullable summaries for existing mounts and fallbacks', () => {
		expect(content(base)).toEqual(base);
		expect(content({ ...base, reviewSummary: null })).toEqual({ ...base, reviewSummary: null });
	});

	it('copies every nested summary value before presentation receives it', () => {
		const out = content({ ...base, reviewSummary: summary }).reviewSummary as typeof summary;
		expect(out).toEqual(summary);
		expect(out).not.toBe(summary);
		expect(out.reviews).not.toBe(summary.reviews);
		expect(out.reviews[0]).not.toBe(summary.reviews[0]);
	});

	it('rejects undeclared metadata, malformed review fields and executable values', () => {
		for (const invalid of [
			{ ...summary, updatedAt: 'private' },
			{ ...summary, score: 4.7 },
			{ ...summary, reviews: [{ text: 'Review', name: 'Name', email: 'private@example.com' }] },
			{ ...summary, reviews: [{ text: () => 'execute', name: 'Name' }] },
			{ ...summary, get count() { throw new Error('must never run'); } },
		]) {
			expect(() => content({ ...base, reviewSummary: invalid })).toThrow(/gateway/);
		}
	});
});
