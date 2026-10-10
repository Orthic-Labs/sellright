// Pass: the mixed body runs inside withLockedSet; the set owns L2 then L3 ordering.
import { withLockedSet } from '../../../src/db/locks.js';
export async function p02(tx: any, s: any, storeId: string, orderId: string) {
  return withLockedSet(storeId, { kind: 'order', orderId }, async (inner: any) => {
    await inner.update(s.order).set({ state: 'Refunded' });
    await inner.delete(s.license);
    await inner.select().from(s.cart).for('update');
  });
}
