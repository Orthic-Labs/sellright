/**
 * DB tests for the Postgres rate-limit backend (SELLRIGHT-ISSUES P1 —
 * "Rate limiting is process-local"). The whole point of this backend is that
 * TWO INDEPENDENT INSTANCES (standing in for two API processes) see the
 * SAME budget for the same (bucket, key) — proven here by constructing the
 * backend twice and never sharing any JS-level state between the two
 * references, only the underlying rate_limit_attempt table.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../db/client.js';
import { env } from '../env.js';
import { createPostgresRateLimitBackend } from './rate-limit-backend.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`rate-limit-backend test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

async function wipe() {
  await pool.query('TRUNCATE rate_limit_attempt');
}

beforeEach(wipe);
afterAll(async () => {
  await wipe();
  await pool.end();
});

describe('postgres rate-limit backend — cross-process sharing', () => {
  it('two independent backend instances (simulating two API processes) share the same budget', async () => {
    // Two SEPARATE closures/instances — no shared JS reference at all, only
    // the same Postgres table underneath. This is the actual regression
    // this backend fixes: an in-memory Map per process would let each
    // instance allow its own 3 attempts independently (6 total); the shared
    // backend must cap at 3 TOTAL across both.
    const processA = createPostgresRateLimitBackend();
    const processB = createPostgresRateLimitBackend();

    expect(await processA.consume('test-bucket', 'shared-key', 60_000, 3)).toBe(0);
    expect(await processB.consume('test-bucket', 'shared-key', 60_000, 3)).toBe(0);
    expect(await processA.consume('test-bucket', 'shared-key', 60_000, 3)).toBe(0);
    // The 4th attempt, from EITHER process, is over the shared cap of 3.
    expect(await processB.consume('test-bucket', 'shared-key', 60_000, 3)).toBeGreaterThan(0);
    expect(await processA.consume('test-bucket', 'shared-key', 60_000, 3)).toBeGreaterThan(0);
  });

  it('check() never records, across instances', async () => {
    const processA = createPostgresRateLimitBackend();
    const processB = createPostgresRateLimitBackend();
    for (let i = 0; i < 50; i++) expect(await processA.check('test-bucket', 'check-only', 60_000, 1)).toBe(0);
    expect(await processB.check('test-bucket', 'check-only', 60_000, 1)).toBe(0);
  });

  it('recordFailure() unconditionally records and is visible to another instance immediately', async () => {
    const processA = createPostgresRateLimitBackend();
    const processB = createPostgresRateLimitBackend();
    await processA.recordFailure('test-bucket', 'fail-key', 60_000);
    expect(await processB.check('test-bucket', 'fail-key', 60_000, 1)).toBeGreaterThan(0);
  });

  it('clear() removes the bucket/key for every instance', async () => {
    const processA = createPostgresRateLimitBackend();
    const processB = createPostgresRateLimitBackend();
    await processA.recordFailure('test-bucket', 'clear-key', 60_000);
    expect(await processB.check('test-bucket', 'clear-key', 60_000, 1)).toBeGreaterThan(0);
    await processB.clear('test-bucket', 'clear-key');
    expect(await processA.check('test-bucket', 'clear-key', 60_000, 1)).toBe(0);
  });

  it('different buckets never share a budget even with the same key', async () => {
    const backend = createPostgresRateLimitBackend();
    expect(await backend.consume('bucket-one', 'same-key', 60_000, 1)).toBe(0);
    expect(await backend.consume('bucket-one', 'same-key', 60_000, 1)).toBeGreaterThan(0);
    // bucket-two, same key: unaffected.
    expect(await backend.consume('bucket-two', 'same-key', 60_000, 1)).toBe(0);
  });

  it('prunes attempts outside the window (sliding, not fixed)', async () => {
    const backend = createPostgresRateLimitBackend();
    // A very short window so the attempt is already stale by the next call.
    expect(await backend.consume('test-bucket', 'sliding-key', 1, 1)).toBe(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(await backend.consume('test-bucket', 'sliding-key', 1, 1)).toBe(0);
  });
});
