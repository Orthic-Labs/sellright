export * from './schema-core.js';
export * from './schema-orders.js';
export * from './schema-content.js';

import { store, productVariant } from './schema-core.js';
import { order } from './schema-orders.js';

export type Store = typeof store.$inferSelect;
export type Order = typeof order.$inferSelect;
export type ProductVariant = typeof productVariant.$inferSelect;
