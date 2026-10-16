/**
 * Process-resource registry for the engine runtime (plan 2.1 shutdown order:
 * "... → close pool"). Modules that lazily open their own connection pool or
 * hold a long-lived handle register a closer here; createApp's shutdown runs
 * them AFTER HTTP has drained and BEFORE the main pools close, so nothing
 * outlives `shutdown()`.
 */
type Closer = { name: string; close: () => Promise<void> | void };
const closers: Closer[] = [];

/** Register a closer. Re-registering the same name replaces the previous one. */
export function onEngineClose(name: string, close: () => Promise<void> | void): void {
  const i = closers.findIndex((c) => c.name === name);
  if (i >= 0) closers.splice(i, 1);
  closers.push({ name, close });
}

/** Run and clear every registered closer. Never throws; returns per-closer failures. */
export async function closeEngineResources(): Promise<Array<{ name: string; error: unknown }>> {
  const list = closers.splice(0, closers.length);
  const failures: Array<{ name: string; error: unknown }> = [];
  for (const c of list.reverse()) {
    try { await c.close(); } catch (error) { failures.push({ name: c.name, error }); }
  }
  return failures;
}

let engineClosed = false;
/** createApp sets this once its pool is closed (end of shutdown). */
export function markEngineClosed(closed: boolean): void { engineClosed = closed; }
export function isEngineClosed(): boolean { return engineClosed; }
