/**
 * Generic entitlements seam for the public license lifecycle routes
 * (routes/apps.ts: activate / refresh / deactivate / trial).
 *
 * A downstream consumer registers hooks that run INSIDE the same
 * store-scoped transaction as the underlying license/activation work, so a
 * hook can:
 *   - add fields to the route's JSON response (e.g. a signed offline
 *     entitlement token, richer lifecycle metadata), or
 *   - veto the request outright by throwing `EntitlementVeto`.
 *
 * A route calls the hook via `callEntitlementHook` INSIDE its `withStore(...)`
 * callback and lets whatever it throws propagate UNCAUGHT out of that
 * callback — never swallowed into a return value there. That's what makes
 * `runStoreTransaction` actually ROLLBACK everything the route (and the hook
 * itself) did in that transaction before the veto reaches HTTP. The route
 * wraps its whole body in `withEntitlementVeto(c, async () => {...})`, which
 * catches `EntitlementVeto` OUTSIDE the transaction and turns it into
 * `{ ok: false, status, message }`; any other error rethrows to the app's
 * generic, sanitizing error handler. Never a partial commit either way.
 *
 * Nothing registered (the default — `entitlementProvider()` returns null)
 * means every route behaves EXACTLY as it did before this seam existed.
 *
 * Registration mirrors the existing per-app registries in this directory
 * (`registerTierCatalog`, `registerDevicePolicy`): a plain in-memory
 * singleton, set once at boot from the consumer's own entrypoint, before
 * requests start flowing.
 */
import type { Tx } from '../db/client.js';
import type { HttpStatus } from '../routes/admin-helpers.js';

/** A license row as read back from activateLicenseOnDevice / findActivationByToken. */
export interface EntitlementLicense {
  id: string;
  status: string;
  seats: number;
  expiresAt: Date | null;
  updatesUntil: Date | null;
  appKey: string;
  licenseKey: string;
  storeId: string;
  metadata: unknown;
  createdAt: Date;
}

/** Fields a hook returns are merged into the route's JSON response, spread
 *  AFTER the route's own built-in fields — a hook may add new fields or,
 *  deliberately, override one of the built-ins. */
export type EntitlementFields = Record<string, unknown>;

/**
 * Thrown by a hook to veto the in-flight request. The route catches this
 * exact type (never a generic `Error`) and turns it into
 * `{ ok: false, status: code, message }` at `httpStatus`.
 *
 * Any OTHER error a hook throws is NOT caught here: it propagates out of the
 * `withStore` callback (rolling the transaction back the same way as a veto)
 * and is handled by the app's generic error handler — logged in full
 * server-side, never echoed to the client, and never left partially
 * committed.
 */
export class EntitlementVeto extends Error {
  constructor(
    public readonly httpStatus: HttpStatus,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'EntitlementVeto';
  }
}

export interface ActivateEntitlementContext {
  storeId: string;
  appKey: string;
  license: EntitlementLicense;
  activationId: string;
  activationToken: string;
  deviceId: string;
  now: Date;
}

export interface RefreshEntitlementContext {
  storeId: string;
  appKey: string;
  license: EntitlementLicense;
  activationId: string;
  /** Present only when the caller supplied one (older/free clients may omit it). */
  deviceId: string | null;
  now: Date;
}

export interface DeactivateEntitlementContext {
  storeId: string;
  appKey: string;
  activationToken: string;
}

export interface TrialEntitlementContext {
  storeId: string;
  appKey: string;
  email: string;
  licenseKey: string;
  customerId: string;
  /** 'issued' = a fresh trial license was minted this call.
   *  'resend' = an existing, still-valid trial's key is being re-sent. */
  outcome: 'issued' | 'resend';
}

export interface EntitlementProvider {
  onActivate?: (tx: Tx, ctx: ActivateEntitlementContext) => Promise<EntitlementFields | void>;
  onRefresh?: (tx: Tx, ctx: RefreshEntitlementContext) => Promise<EntitlementFields | void>;
  onDeactivate?: (tx: Tx, ctx: DeactivateEntitlementContext) => Promise<EntitlementFields | void>;
  onTrial?: (tx: Tx, ctx: TrialEntitlementContext) => Promise<EntitlementFields | void>;
}

let provider: EntitlementProvider | null = null;

/** Register the single active entitlements provider. Call once at boot,
 *  before requests start flowing (mirrors registerTierCatalog / registerDevicePolicy).
 *  Registering twice simply replaces the previous provider. */
export function registerEntitlementProvider(p: EntitlementProvider): void {
  provider = p;
}

/** Internal: read by routes/apps.ts. */
export function entitlementProvider(): EntitlementProvider | null {
  return provider;
}

/** Test/deploy seam: drop the registered provider. */
export function clearEntitlementProvider(): void {
  provider = null;
}

/**
 * Run a route's hook point (a no-op returning null when no hook/provider is
 * registered). Deliberately does NOT catch `EntitlementVeto` (or anything
 * else): both must propagate out of the enclosing `withStore` callback
 * unchanged so `runStoreTransaction` rolls the transaction back before
 * either kind of throw reaches the route. Catching here and turning a veto
 * into ordinary return data would let the callback resolve "normally" and
 * COMMIT everything the route already did — the exact partial-commit bug
 * this seam exists to prevent. See `withEntitlementVeto` for where the veto
 * is actually turned into a response, OUTSIDE the transaction.
 */
export async function callEntitlementHook<C>(
  hook: ((tx: Tx, ctx: C) => Promise<EntitlementFields | void>) | undefined,
  tx: Tx,
  ctx: C,
): Promise<EntitlementFields | null> {
  if (!hook) return null;
  const fields = await hook(tx, ctx);
  return fields ?? null;
}

/**
 * Wrap a route body: run `fn` (which does its own `withStore(...)` work,
 * possibly calling `callEntitlementHook`) and, if an `EntitlementVeto`
 * propagates out of it, turn it into the route's `{ ok: false, status, message }`
 * JSON error at its `httpStatus` — mirrors `guard()` in admin-helpers.ts, but
 * for this domain's own veto type and response shape. By the time this catch
 * runs, `withStore` has already rolled the transaction back (the veto was
 * thrown INSIDE that callback), so nothing the route or the hook did commits.
 * Any other error rethrows for the app's generic (sanitizing) error handler.
 */
export async function withEntitlementVeto<T>(
  c: { json: (body: unknown, status?: number) => Response },
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof EntitlementVeto) {
      return c.json({ ok: false, status: e.code, message: e.message }, e.httpStatus) as unknown as T;
    }
    throw e;
  }
}
