// O2: order update before withLockedSet (the set acquires L2 and L3 after L3 is held).
import { withLockedSet } from '../../../src/db/locks.js';
export async function f08(tx: any, s: any, storeId: string, orderId: string) {
  await tx.update(s.order).set({ notes: 'x' });
  await withLockedSet(storeId, { kind: 'order', orderId }, async () => undefined);
}
