import { sql } from 'drizzle-orm';
import type { Tx } from './client.js';

let seq = 0;

/**
 * Run `fn` inside a SAVEPOINT of the caller's transaction. On failure only the
 * savepoint is rolled back and the error is rethrown (the outer transaction
 * stays usable). Raw SAVEPOINT statements are used on purpose: `tx.transaction()`
 * on a drizzle session built over a PoolClient issues a real BEGIN/COMMIT and
 * would commit or abort the caller's transaction.
 */
export async function withSavepoint<T>(tx: Tx, fn: () => Promise<T>): Promise<T> {
  const name = `sp_${++seq}`;
  await tx.execute(sql.raw(`SAVEPOINT ${name}`));
  try {
    const out = await fn();
    await tx.execute(sql.raw(`RELEASE SAVEPOINT ${name}`));
    return out;
  } catch (e) {
    await tx.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${name}`)).catch(() => undefined);
    throw e;
  }
}
