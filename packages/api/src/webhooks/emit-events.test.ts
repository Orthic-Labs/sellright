/** V64: emitEvents batches one topic's events into one endpoint read + one insert. */
import { describe, expect, it, vi } from 'vitest';
import type { Tx } from '../db/client.js';
import { emitEvents } from './emit.js';

function fakeTx(endpoints: Array<{ id: string; topics: string[] }>) {
  const inserted: unknown[][] = [];
  const select = vi.fn(() => ({ from: () => ({ where: async () => endpoints }) }));
  const insert = vi.fn(() => ({ values: async (v: unknown[]) => { inserted.push(v); } }));
  return { tx: { select, insert } as unknown as Tx, select, insert, inserted };
}

describe('emitEvents', () => {
  it('reads endpoints once and inserts every payload x matching endpoint in one statement', async () => {
    const f = fakeTx([{ id: 'e1', topics: ['cart.abandoned'] }, { id: 'e2', topics: ['*'] }, { id: 'e3', topics: ['order.created'] }]);
    await emitEvents(f.tx, 's', 'cart.abandoned', [{ token: 'a' }, { token: 'b' }]);
    expect(f.select).toHaveBeenCalledTimes(1);
    expect(f.insert).toHaveBeenCalledTimes(1);
    expect(f.inserted[0]).toHaveLength(4);
    expect(f.inserted[0]!.map((r) => (r as { endpointId: string }).endpointId).sort()).toEqual(['e1', 'e1', 'e2', 'e2']);
  });
  it('does nothing for an empty batch', async () => {
    const f = fakeTx([{ id: 'e1', topics: ['*'] }]);
    await emitEvents(f.tx, 's', 'cart.abandoned', []);
    expect(f.select).not.toHaveBeenCalled();
  });
  it('refuses the reserved canary topic', async () => {
    const f = fakeTx([]);
    await expect(emitEvents(f.tx, 's', 'health.canary', [{}])).rejects.toThrow();
  });
});
