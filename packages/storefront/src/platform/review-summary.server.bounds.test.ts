// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({ lstat: vi.fn(), realpath: vi.fn(), open: vi.fn(), read: vi.fn(), stat: vi.fn(), close: vi.fn() }));
vi.mock('node:fs/promises', () => ({ lstat: io.lstat, realpath: io.realpath, open: io.open }));
import { readReviewSummary } from './review-summary.server';

const file = '/sellright-private/reviews.json';
const regular = { isFile: () => true, size: 10, dev: 1, ino: 2 };
beforeEach(() => {
	for (const mock of Object.values(io)) mock.mockReset();
	vi.stubEnv('SELLRIGHT_REVIEW_SUMMARY_FILE', file);
	io.lstat.mockResolvedValue(regular);
	io.realpath.mockResolvedValue(file);
	io.open.mockResolvedValue({ read: io.read, stat: io.stat, close: io.close });
	io.stat.mockResolvedValue(regular);
	io.close.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe('bounded regular-file reads', () => {
	it('never opens a FIFO/device or oversized file', async () => {
		for (const stat of [{ ...regular, isFile: () => false }, { ...regular, size: 64 * 1024 + 1 }]) {
			io.lstat.mockResolvedValueOnce(stat);
			expect(await readReviewSummary()).toBeNull();
		}
		expect(io.open).not.toHaveBeenCalled();
	});

	it('rejects replacement with a different inode or nonregular file before any read, closing descriptor', async () => {
		for (const stat of [{ ...regular, ino: 3 }, { ...regular, isFile: () => false }, { ...regular, size: 64 * 1024 + 1 }]) {
			io.stat.mockResolvedValueOnce(stat);
			expect(await readReviewSummary()).toBeNull();
		}
		expect(io.read).not.toHaveBeenCalled();
		expect(io.close).toHaveBeenCalledTimes(3);
	});

	it('bounds bytes even if a regular file grows after stat', async () => {
		io.read.mockImplementation(async (buffer: Buffer, offset: number, length: number) => {
			buffer.fill(32, offset, offset + length);
			return { bytesRead: length };
		});
		expect(await readReviewSummary()).toBeNull();
		expect(io.read).toHaveBeenCalledTimes(1);
		const [buffer, offset, length, position] = io.read.mock.calls[0];
		expect(buffer.length).toBe(64 * 1024 + 1);
		expect([offset, length, position]).toEqual([0, 64 * 1024 + 1, 0]);
		expect(io.close).toHaveBeenCalledOnce();
	});

	it('closes the opened descriptor after a read error', async () => {
		io.read.mockRejectedValueOnce(new Error('read failed'));
		expect(await readReviewSummary()).toBeNull();
		expect(io.close).toHaveBeenCalledOnce();
	});
});
