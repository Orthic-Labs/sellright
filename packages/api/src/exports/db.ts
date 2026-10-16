/** `@sellright/api/db` — RLS-scoped transaction runner and handle type. The raw pool and unscoped client are NOT exported (use `ctx.pool`; operator scripts use `/ops`). */
export { withStore, type Tx } from '../db/client.js';
