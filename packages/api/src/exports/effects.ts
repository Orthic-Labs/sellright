/**
 * `@sellright/api/effects` — the pending-effects worker surface (de-fork plan 2.8): one claim/execute pass over
 * `order_pending_effect`, and the open-row count a drain loop and heartbeat need. Operator/worker use only.
 */
import '../payments/settlement/record.js'; // registers the built-in effect handlers (as scripts/effects-worker.ts does)
export { countOpenEffects, runEffectsPass } from '../payments/settlement/effects.js';
