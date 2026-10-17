// @vitest-environment node
import { mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readReviewSummary } from './review-summary.server';

const first = { score: '4.7', count: '298+', reviews: [{ text: 'Customer review, preserved verbatim.', name: 'Reviewer' }] };
let dir: string;
let file: string;

beforeEach(async () => {
	dir = await realpath(await mkdtemp(join(tmpdir(), 'sellright-review-summary-')));
	file = join(dir, 'reviews.json');
	vi.stubEnv('SELLRIGHT_REVIEW_SUMMARY_FILE', file);
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(dir, { recursive: true, force: true });
});

describe('optional runtime editorial review summary', () => {
	it('reads each published generation afresh, projecting only displayed data', async () => {
		await writeFile(file, JSON.stringify({ ...first, updatedAt: 'private producer metadata', path: '/private', reviews: [{ ...first.reviews[0], internal: 'never display' }] }));
		expect(await readReviewSummary()).toEqual(first);
		const second = { score: '4.8', count: '310', reviews: [{ text: 'New published review.', name: 'New customer' }] };
		await writeFile(join(dir, 'next.json'), JSON.stringify(second));
		await rename(join(dir, 'next.json'), file);
		expect(await readReviewSummary()).toEqual(second);
		await writeFile(file, '{');
		expect(await readReviewSummary()).toBeNull();
		await writeFile(file, JSON.stringify(first));
		expect(await readReviewSummary()).toEqual(first);
	});

	it('missing, unset, relative and URL sources return null without network requests', async () => {
		const fetch = vi.fn();
		vi.stubGlobal('fetch', fetch);
		try {
			for (const source of ['', 'reviews.json', 'file:///tmp/reviews.json', 'https://example.com/reviews.json', file]) {
				vi.stubEnv('SELLRIGHT_REVIEW_SUMMARY_FILE', source);
				expect(await readReviewSummary(), source).toBeNull();
			}
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('rejects malformed JSON, invalid UTF-8 and oversized files', async () => {
		for (const invalid of ['{', 'null', '[]', ' '.repeat(64 * 1024 + 1), Buffer.from([0xc3, 0x28])]) {
			await writeFile(file, invalid);
			expect(await readReviewSummary()).toBeNull();
		}
	});

	it('accepts exactly 64 KiB and six reviews', async () => {
		const value = { ...first, reviews: Array.from({ length: 6 }, () => ({ ...first.reviews[0] })) };
		const json = JSON.stringify(value);
		await writeFile(file, json + ' '.repeat(64 * 1024 - Buffer.byteLength(json)));
		expect(await readReviewSummary()).toEqual(value);
	});

	it('rejects invalid fields, excessive review counts and unbounded strings', async () => {
		const invalid = [
			{ ...first, score: 4.7 }, { ...first, count: null }, { ...first, count: '' },
			{ ...first, score: 'x'.repeat(33) }, { ...first, count: 'x'.repeat(33) },
			{ ...first, reviews: {} }, { ...first, reviews: Array.from({ length: 7 }, () => first.reviews[0]) },
			{ ...first, reviews: [null] }, { ...first, reviews: [{ text: 'ok', name: 5 }] },
			{ ...first, reviews: [{ text: 'x'.repeat(8193), name: 'ok' }] },
			{ ...first, reviews: [{ text: 'ok', name: 'x'.repeat(257) }] },
			{ ...first, reviews: [{ text: '\u0000', name: 'ok' }] },
		];
		for (const value of invalid) {
			await writeFile(file, JSON.stringify(value));
			expect(await readReviewSummary()).toBeNull();
		}
	});

	it('rejects directories, symlink files and symlink parent directories', async () => {
		await mkdir(file);
		expect(await readReviewSummary()).toBeNull();
		await rm(file, { recursive: true });
		const target = join(dir, 'target.json');
		await writeFile(target, JSON.stringify(first));
		await symlink(target, file);
		expect(await readReviewSummary()).toBeNull();
		await rm(file);
		const parentLink = join(dir, 'linked');
		await symlink(dir, parentLink);
		vi.stubEnv('SELLRIGHT_REVIEW_SUMMARY_FILE', join(parentLink, 'target.json'));
		expect(await readReviewSummary()).toBeNull();
	});
});
