/**
 * De-fork plan 2.9 — storekit_event stage-aware resolution rules.
 * Runs against a *_test database only (TRUNCATEs store CASCADE).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { recordStoreKitEvent, recordStoreKitEventDetached, type StoreKitEventInput } from './storekit-events.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`storekit-events test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const A = 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1';
const B = 'b2b2b2b2-b2b2-b2b2-b2b2-b2b2b2b2b2b2';
const OP = 'notification:n-1';

type Ev = { id: string; operation_id: string; stage: string; outcome: string; error: string | null; resolved_by_event_id: string | null };
const events = (store: string) => withStore(store, async (tx) => {
  const r = await tx.execute(sql`SELECT id, operation_id, stage, outcome, error, resolved_by_event_id FROM storekit_event ORDER BY created_at, id`);
  return r.rows as Ev[];
});
const unresolvedApply = async (store: string) =>
  (await events(store)).filter((e) => e.stage === 'apply' && e.outcome === 'failed' && e.resolved_by_event_id === null);
const rec = (store: string, i: Omit<StoreKitEventInput, 'storeId'>) => withStore(store, (tx) => recordStoreKitEvent(tx, { storeId: store, ...i }));

beforeEach(async () => {
  await pool.query('TRUNCATE store CASCADE');
  for (const [id, slug] of [[A, 'sk-ev-a'], [B, 'sk-ev-b']]) {
    await pool.query(`INSERT INTO store (id, slug, name) VALUES ($1, $2, $2)`, [id, slug]);
  }
});
afterAll(async () => { await pool.query('TRUNCATE store CASCADE'); await pool.end(); });

describe('storekit_event resolution', () => {
  it('repeated apply failures with intervening verify successes stay unresolved until a committed apply', async () => {
    await rec(A, { operationId: OP, stage: 'apply', outcome: 'failed', error: 'boom 1' });
    await rec(A, { operationId: OP, stage: 'verify', outcome: 'ok' });
    await rec(A, { operationId: OP, stage: 'apply', outcome: 'failed', error: 'boom 2' });
    await rec(A, { operationId: OP, stage: 'verify', outcome: 'ok' });
    await rec(A, { operationId: OP, stage: 'verify', outcome: 'ok' });
    expect(await unresolvedApply(A)).toHaveLength(2);

    const ok = await rec(A, { operationId: OP, stage: 'apply', outcome: 'ok' });
    expect(ok.resolved).toBe(2);
    expect(await unresolvedApply(A)).toHaveLength(0);
    const resolved = (await events(A)).filter((e) => e.stage === 'apply' && e.outcome === 'failed');
    expect(resolved.every((e) => e.resolved_by_event_id === ok.id)).toBe(true);
  });

  it('an apply success in a rolled-back transaction resolves nothing (only a COMMITTED apply does)', async () => {
    await rec(A, { operationId: OP, stage: 'apply', outcome: 'failed', error: 'boom' });
    await expect(withStore(A, async (tx) => {
      await recordStoreKitEvent(tx, { storeId: A, operationId: OP, stage: 'apply', outcome: 'ok' });
      throw new Error('apply tx rolls back after the marker was written');
    })).rejects.toThrow();
    expect(await unresolvedApply(A)).toHaveLength(1);
    expect((await events(A)).filter((e) => e.outcome === 'ok')).toHaveLength(0);
  });

  it('verify success resolves only earlier verify failures of the same operation', async () => {
    await rec(A, { operationId: OP, stage: 'verify', outcome: 'failed', error: 'verify:retryable' });
    await rec(A, { operationId: OP, stage: 'apply', outcome: 'failed', error: 'boom' });
    await rec(A, { operationId: 'notification:other', stage: 'verify', outcome: 'failed', error: 'verify:bad_signature' });
    const v = await rec(A, { operationId: OP, stage: 'verify', outcome: 'ok' });
    expect(v.resolved).toBe(1);
    const evs = await events(A);
    expect(evs.find((e) => e.operation_id === OP && e.stage === 'verify' && e.outcome === 'failed')!.resolved_by_event_id).toBe(v.id);
    expect(evs.find((e) => e.operation_id === OP && e.stage === 'apply')!.resolved_by_event_id).toBeNull();
    expect(evs.find((e) => e.operation_id === 'notification:other')!.resolved_by_event_id).toBeNull();
  });

  it('replay rows never resolve anything', async () => {
    await rec(A, { operationId: OP, stage: 'apply', outcome: 'failed', error: 'boom' });
    await rec(A, { operationId: OP, stage: 'verify', outcome: 'failed', error: 'verify:retryable' });
    const r = await rec(A, { operationId: OP, stage: 'replay', outcome: 'ok' });
    expect(r.resolved).toBe(0);
    expect((await events(A)).filter((e) => e.outcome === 'failed' && e.resolved_by_event_id !== null)).toHaveLength(0);
  });

  it('a failure resolves nothing, and a later apply failure after a success is unresolved again', async () => {
    await rec(A, { operationId: OP, stage: 'apply', outcome: 'failed', error: 'one' });
    await rec(A, { operationId: OP, stage: 'apply', outcome: 'ok' });
    const f = await rec(A, { operationId: OP, stage: 'apply', outcome: 'failed', error: 'regression' });
    expect(f.resolved).toBe(0);
    expect(await unresolvedApply(A)).toHaveLength(1);
  });

  it('resolution is tenant-scoped: another store\'s apply of the same operation id resolves nothing here', async () => {
    await rec(A, { operationId: OP, stage: 'apply', outcome: 'failed', error: 'boom' });
    await rec(B, { operationId: OP, stage: 'apply', outcome: 'ok' });
    expect(await unresolvedApply(A)).toHaveLength(1);
  });

  // Tenant isolation for storekit_event is covered by src/db/rls-tables.test.ts, which
  // discovers every store-scoped table and checks it as the non-owner NOBYPASSRLS role.

  it('only failed rows may carry a resolver (CHECK)', async () => {
    const ok = await rec(A, { operationId: OP, stage: 'apply', outcome: 'ok' });
    await expect(withStore(A, (tx) => tx.execute(sql`UPDATE storekit_event SET resolved_by_event_id = ${ok.id} WHERE id = ${ok.id}`)))
      .rejects.toMatchObject({ cause: { message: expect.stringMatching(/storekit_event_resolved_only_failed/) } });
  });

  it('detached writer swallows its own errors (instrumentation must not change HTTP outcomes)', async () => {
    await expect(recordStoreKitEventDetached({ storeId: '00000000-0000-0000-0000-000000000000', operationId: OP, stage: 'verify', outcome: 'ok' })).resolves.toBeUndefined();
  });
});
