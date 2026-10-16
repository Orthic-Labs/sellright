/**
 * Post-commit callback registry for store transactions. A caller that needs a
 * side effect to run only once its transaction has COMMITTED (never inside it,
 * per db/no-external-io-in-transaction) registers it against the tx; the
 * callbacks fire after COMMIT in runStoreTransaction and are discarded on
 * ROLLBACK. Registration is a no-op for transactions not opened by
 * runStoreTransaction, so an unmanaged tx simply falls back to the poll.
 * Callbacks never throw into the caller.
 */
const pending = new WeakMap<object, Array<() => void>>();

/** Called by runStoreTransaction right after BEGIN. */
export function beginAfterCommit(client: object): void {
  pending.set(client, []);
}

/** Register `fn` to run after the tx that owns `tx.$client` commits. */
export function afterCommit(tx: { $client: object }, fn: () => void): void {
  pending.get(tx.$client)?.push(fn);
}

/** Called by runStoreTransaction right after COMMIT succeeds. */
export function flushAfterCommit(client: object): void {
  const queued = pending.get(client);
  pending.delete(client);
  if (!queued) return;
  for (const fn of queued) {
    try {
      fn();
    } catch {
      // A post-commit hook must never fail the request that already committed.
    }
  }
}

/** Called by runStoreTransaction when the tx rolls back or COMMIT fails. */
export function discardAfterCommit(client: object): void {
  pending.delete(client);
}
