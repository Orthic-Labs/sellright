import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import type { ContentViewProps } from '~/platform/views';

type ReviewSummary = NonNullable<ContentViewProps['reviewSummary']>;
const MAX_BYTES = 64 * 1024;
const MAX_REVIEWS = 6;
const plainObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const validText = (value: unknown, limit: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !/\p{Cc}/u.test(value.replace(/[\t\n\r]/g, ''));

/** Validate untrusted JSON, retaining exactly the displayed fields (never producer metadata). */
function projectSummary(value: unknown): ReviewSummary | null {
	if (!plainObject(value) || !validText(value.score, 32) || !validText(value.count, 32) || !Array.isArray(value.reviews) || value.reviews.length > MAX_REVIEWS) return null;
	const reviews: ReviewSummary['reviews'] = [];
	for (const review of value.reviews) {
		if (!plainObject(review) || !validText(review.text, 8192) || !validText(review.name, 256)) return null;
		reviews.push({ text: review.text, name: review.name });
	}
	return { score: value.score, count: value.count, reviews };
}

/** No request-selected path, network or cache: each load opens the optional private runtime file anew. */
export async function readReviewSummary(): Promise<ReviewSummary | null> {
	const file = process.env.SELLRIGHT_REVIEW_SUMMARY_FILE;
	if (!file || file.length > 4096 || file.includes('\0') || !isAbsolute(file) || /^[\\/]{2}/.test(file)) return null;
	// Fail closed on a host without flags that prevent symlink traversal and blocking FIFO opens.
	if (typeof constants.O_NOFOLLOW !== 'number' || typeof constants.O_NONBLOCK !== 'number') return null;
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		const entry = await lstat(file);
		if (!entry.isFile() || entry.size > MAX_BYTES || await realpath(file) !== resolve(file)) return null;
		handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > MAX_BYTES || stat.dev !== entry.dev || stat.ino !== entry.ino) return null;
		// One extra byte detects growth after stat; total I/O and allocation remain bounded.
		const bytes = Buffer.alloc(MAX_BYTES + 1);
		let length = 0;
		while (length < bytes.length) {
			const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
			if (bytesRead === 0) break;
			length += bytesRead;
		}
		if (length > MAX_BYTES) return null;
		return projectSummary(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))));
	} catch {
		return null;
	} finally {
		await handle?.close().catch(() => {});
	}
}
