/**
 * Reserved health-canary marker (PLAN 7.16, I-8, X-34). Canary rows are the
 * only rows that may carry `canary: true` / `marker: 'health.canary'`. Every
 * public and merchant enqueue path rejects them, so a customer-facing or
 * merchant-configured delivery can never be mistaken for (or excluded as) a
 * canary. Kept dependency-free so outbox, webhook, push and route modules can
 * all import it without cycles.
 */
export const CANARY_TOPIC = 'health.canary';
export const CANARY_MARKER = 'health.canary';

export class ReservedMarkerError extends Error {
  constructor(what: string) {
    super(`${what} carries the reserved marker ${CANARY_MARKER}`);
    this.name = 'ReservedMarkerError';
  }
}

/** True when a payload object carries any canary-reserved key. */
export function hasReservedCanaryKeys(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const p = payload as Record<string, unknown>;
  return 'canary' in p || p.marker === CANARY_MARKER;
}

/** Throws unless the caller is the internal canary path (`allowCanary`). */
export function assertNotReserved(what: string, payload: unknown, allowCanary: boolean): void {
  if (allowCanary) return;
  if (hasReservedCanaryKeys(payload)) throw new ReservedMarkerError(what);
}

/** Reject a reserved topic on a non-canary path. */
export function assertNotReservedTopic(what: string, topic: string, allowCanary: boolean): void {
  if (!allowCanary && topic === CANARY_TOPIC) throw new ReservedMarkerError(what);
}
