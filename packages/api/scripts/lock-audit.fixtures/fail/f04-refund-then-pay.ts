// O2: L0 refund: key acquired before L0 pay: key (refund-then-pay nesting, §5.5).
import { withAdvisoryLock } from '../../../src/db/client.js';
export async function f04(orderId: string, fn: () => Promise<void>) {
  await withAdvisoryLock(`refund:x:${orderId}`, async () => {
    await withAdvisoryLock(`pay:x:${orderId}`, fn);
  });
}
