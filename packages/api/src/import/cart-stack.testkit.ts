import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { createSession } from '../auth/session.js';
export async function seedImportedCartSeams(STORE: string, PRODUCT: string, VARIANT: string, CUSTOMER: string) {
  return withStore(STORE, async tx => {
    await tx.insert(s.store).values({ id: STORE, slug: 'synthetic-cart-seams', name: 'Synthetic seams', currency: 'USD',
      config: { loyalty: { enabled: true, pointsPerDollarOff: 10 } } });
    await tx.insert(s.product).values({ id: PRODUCT, storeId: STORE, slug: 'synthetic', name: 'Synthetic', status: 'active' });
    await tx.insert(s.productVariant).values({ id: VARIANT, storeId: STORE, productId: PRODUCT, sku: 'SYNTHETIC',
      name: 'Synthetic', price: 1000, fulfillmentType: 'digital_download', metafields: { vendureId: 17 } });
    await tx.insert(s.customer).values({ id: CUSTOMER, storeId: STORE, email: 'synthetic@example.invalid', emailVerified: true });
    const sessionToken = await createSession(tx, STORE, CUSTOMER);
    await tx.insert(s.loyaltyLedger).values({ storeId: STORE, customerId: CUSTOMER, kind: 'adjust', points: 100, sourceRef: 'synthetic-opening' });
    await tx.insert(s.shippingMethod).values({ storeId: STORE, code: 'threshold', name: 'Threshold',
      calculator: { flat: 100, min: 750, subtotalBasis: 'discounted_with_tax' } });
    return sessionToken;
  });
}
