import { server$ } from '@qwik.dev/router';
import { trackOrder } from '~/sellright/content';
import type { TrackedOrder } from '~/sellright/types/content';

export interface OrderTrackingResult {
  order?: TrackedOrder;
  error?: string;
  success: boolean;
}

/** Guest order tracking — SellRight REST (`GET /v1/shop/track`, code + email),
 *  typed end to end through `~/sellright/content` and `TrackedOrder`. No
 *  Vendure/GraphQL shape involved — `OrderDetails`/`OrderTracking` render the
 *  API's own native fields directly. */
export const trackOrderServer = server$(async (orderCode: string, email: string): Promise<OrderTrackingResult> => {
  const result = await trackOrder(orderCode, email);
  return result;
});
