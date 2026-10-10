// issueLicensesForPaidOrder gate (order-edit top-up): refusal inserts nothing, the patch lands on the inserted rows only (pure, no database).
import { describe, expect, it, vi } from 'vitest';
import type { Tx } from '../db/client.js';
import { issueLicensesForPaidOrder } from './issue.js';

const LINE = { orderLineId: 'l1', quantity: 1, fulfillmentType: 'license', appKey: 'gateapp', licenseSeats: 1, updatesDurationDays: null, licenseDurationDays: null, metadata: null };

/** Awaitable query-builder fake: any chained method returns itself; awaiting resolves the next queued result. */
function fakeTx(results: unknown[][]) {
  const inserted: Record<string, unknown>[][] = [];
  const queue = [...results];
  const chain = (): unknown => {
    const rows = queue.shift() ?? [];
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'innerJoin', 'where', 'limit']) c[m] = () => c;
    c.then = (resolve: (v: unknown) => unknown) => resolve(rows);
    return c;
  };
  const tx = {
    execute: vi.fn(async () => ({ rows: [] })),
    select: vi.fn(chain),
    insert: vi.fn(() => ({ values: async (v: Record<string, unknown>[]) => { inserted.push(v); } })),
  } as unknown as Tx;
  return { tx, inserted };
}
const opts = { storeId: 's1', orderId: 'o1', customerId: null };

describe('issueLicensesForPaidOrder gate', () => {
  it('no gate: inserts the grant with the variant metadata untouched (today\'s behaviour)', async () => {
    const { tx, inserted } = fakeTx([[LINE], []]);
    expect(await issueLicensesForPaidOrder(tx, opts)).toBe(1);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]![0]!.metadata).toBeNull();
  });

  it('gate refuses: nothing is inserted and 0 is returned', async () => {
    const { tx, inserted } = fakeTx([[LINE], []]);
    const gate = vi.fn(async () => ({ ok: false as const }));
    expect(await issueLicensesForPaidOrder(tx, { ...opts, gate })).toBe(0);
    expect(gate).toHaveBeenCalledTimes(1);
    expect(inserted).toEqual([]);
  });

  it('gate returns a metadata patch: the newly inserted row carries it, merged over the variant metadata', async () => {
    const { tx, inserted } = fakeTx([[{ ...LINE, metadata: { keep: 1, over: 'old' } }], []]);
    const gate = vi.fn(async () => ({ ok: true as const, metadataPatch: { over: 'new', mobile_upgrade_source_id: 'src-1' } }));
    expect(await issueLicensesForPaidOrder(tx, { ...opts, gate })).toBe(1);
    expect(inserted[0]![0]!.metadata).toEqual({ keep: 1, over: 'new', mobile_upgrade_source_id: 'src-1' });
  });

  it('gate ok without a patch: metadata is identical to the ungated path', async () => {
    const { tx, inserted } = fakeTx([[LINE], []]);
    await issueLicensesForPaidOrder(tx, { ...opts, gate: async () => ({ ok: true }) });
    expect(inserted[0]![0]!.metadata).toBeNull();
  });

  it('gate is not consulted when the line is already fully issued (nothing new to gate)', async () => {
    const { tx, inserted } = fakeTx([[LINE], [{ orderLineId: 'l1' }]]);
    const gate = vi.fn(async () => ({ ok: false as const }));
    expect(await issueLicensesForPaidOrder(tx, { ...opts, gate })).toBe(0);
    expect(gate).not.toHaveBeenCalled();
    expect(inserted).toEqual([]);
  });
});
