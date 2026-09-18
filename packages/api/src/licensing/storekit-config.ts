// StoreKit per-app configuration loading — the ONLY source of truth for
// which bundle ids / products / environments this deployment honors.
//
// Ported upstream from RightSites, where these knobs were single-app env
// vars (HEARDRIGHT_STOREKIT_*). SellRight is multi-store, so the config is
// per-(store, app) rows in `storekit_app` (migration 0066): bundleId,
// appAppleId, product→entitlement map, and the sandbox policy are all
// operator-managed config. NOTHING here is inferred from untrusted client
// input — a signed JWS's bundleId is used to SELECT which config row
// verifies it, and the signature check then proves that claim.
import { and, eq, sql } from 'drizzle-orm';
import type { SignedDataVerifier } from '@apple/app-store-server-library';
import { unsafeUnscopedDb, type Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { env } from '../env.js';
import type { StoreKitDeploymentConfig } from './storekit-verify.js';

/** What one configured productId entitles the buyer to. See
 *  schema-storekit.ts `storekitApp.productMap` for the column's shape. */
export interface StoreKitProductEntitlement {
  tier?: string;
  /** Device-activation cap. <= 0 or absent = unlimited (Apple-ID-bound
   *  purchases are inherently per-account). */
  seats?: number;
  /** Non-subscription license duration. Null/absent = perpetual.
   *  Auto-renewable subscriptions ignore this and adopt each signed
   *  transaction's expiresDate instead. */
  licenseDurationDays?: number | null;
  /** Update-eligibility window. Absent = tracks the license expiry. */
  updatesDurationDays?: number | null;
}

export interface StoreKitAppConfig {
  id: string;
  storeId: string;
  appKey: string;
  bundleId: string;
  appAppleId: number | null;
  allowSandbox: boolean;
  productMap: Record<string, StoreKitProductEntitlement>;
}

/** Parse a storekit_app.product_map blob into the typed map. Unknown or
 *  malformed entries are dropped rather than trusted — a config row that
 *  can't be read fails closed (the product simply isn't sellable). */
export function parseStoreKitProductMap(raw: unknown): Record<string, StoreKitProductEntitlement> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, StoreKitProductEntitlement> = {};
  for (const [productId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!productId || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const v = value as Record<string, unknown>;
    out[productId] = {
      tier: typeof v.tier === 'string' ? v.tier : undefined,
      seats: typeof v.seats === 'number' && Number.isInteger(v.seats) ? v.seats : undefined,
      licenseDurationDays: typeof v.licenseDurationDays === 'number' ? v.licenseDurationDays : null,
      updatesDurationDays: typeof v.updatesDurationDays === 'number' ? v.updatesDurationDays : null,
    };
  }
  return out;
}

type AppRow = typeof s.storekitApp.$inferSelect;

function toConfig(row: AppRow): StoreKitAppConfig {
  return {
    id: row.id,
    storeId: row.storeId,
    appKey: row.appKey,
    bundleId: row.bundleId,
    appAppleId: row.appAppleId ?? null,
    allowSandbox: row.allowSandbox,
    productMap: parseStoreKitProductMap(row.productMap),
  };
}

/**
 * Pre-tenant routing: which store owns this Apple bundle id?
 *
 * An inbound App Store Server Notification arrives with NO store context —
 * the bundle id inside Apple's signed payload IS the tenant selector.
 * Reading it unverified to pick the tenant is a ROUTING decision only: the
 * JWS signature check that immediately follows is what proves the bundle
 * id, so a forged payload can at most select the "wrong" verifier and then
 * fail verification.
 *
 * FORCE RLS makes a scoped query fail closed here (no app.current_store),
 * so the lookup goes through the SECURITY DEFINER seam
 * `resolve_store_for_storekit_bundle` (migration 0066 — the same pattern as
 * 0053's gateway tenant resolution). It returns ONLY a store_id; the config
 * row itself is re-read inside withStore by loadStoreKitAppByBundleId.
 */
export async function resolveStoreIdForStoreKitBundle(bundleId: string): Promise<string | null> {
  const res = await unsafeUnscopedDb.execute(
    sql`SELECT public.resolve_store_for_storekit_bundle(${bundleId}) AS store_id`,
  );
  const row = (res as unknown as { rows: Array<{ store_id: string | null }> }).rows[0];
  return row?.store_id ?? null;
}

/** Read the app config for a bundle id INSIDE the tenant context resolved
 *  by resolveStoreIdForStoreKitBundle — the config row never crosses RLS. */
export async function loadStoreKitAppByBundleId(
  tx: Tx,
  storeId: string,
  bundleId: string,
): Promise<StoreKitAppConfig | null> {
  const [row] = await tx
    .select()
    .from(s.storekitApp)
    .where(and(eq(s.storekitApp.storeId, storeId), eq(s.storekitApp.bundleId, bundleId)))
    .limit(1);
  return row ? toConfig(row) : null;
}

/** Store-scoped lookup used by the client-facing link endpoint: resolves the
 *  app config for (storeId, appKey) INSIDE the RLS transaction so a store can
 *  never reach another tenant's StoreKit config. */
export async function loadStoreKitAppConfig(tx: Tx, storeId: string, appKey: string): Promise<StoreKitAppConfig | null> {
  const [row] = await tx
    .select()
    .from(s.storekitApp)
    .where(and(eq(s.storekitApp.storeId, storeId), eq(s.storekitApp.appKey, appKey)))
    .limit(1);
  return row ? toConfig(row) : null;
}

// ── test-only verifier injection ────────────────────────────────────────────
// Routes build their StoreKitDeploymentConfig through deploymentConfigFor,
// which attaches injected SignedDataVerifier instances when this override is
// set. Tests install verifiers rooted at a throwaway openssl CA (see
// storekit-verify.test.ts / storekit-webhooks.db.test.ts). Production code
// never sets this — the override is process-global and cleared in afterAll.
let verifierOverrideForTests: ((bundleId: string) => { production?: SignedDataVerifier; sandbox?: SignedDataVerifier } | undefined) | undefined;

export function _setStoreKitVerifierOverrideForTests(
  fn: ((bundleId: string) => { production?: SignedDataVerifier; sandbox?: SignedDataVerifier } | undefined) | undefined,
): void {
  verifierOverrideForTests = fn;
}

/** Build the verifier config for one configured app. Every field comes from
 *  the storekit_app row plus deployment-wide env knobs — never the request.
 *
 *  - `allowedProductIds`: the keys of the configured product map. A purchase
 *    for a product we don't sell simply isn't verifiable here.
 *  - `allowSandbox`: per-app policy AND the STOREKIT_ALLOW_SANDBOX global
 *    kill switch — both must permit Sandbox for it to be attempted.
 *  - `onlineChecks`: STOREKIT_ONLINE_CHECKS (default on) — OCSP revocation
 *    checking; only disabled on networks that cannot reach Apple OCSP.
 *  - `appAppleId`: absent ⇒ Production verification is never attempted at
 *    all (fail closed on real Production purchases; TestFlight keeps working). */
export function deploymentConfigFor(appCfg: StoreKitAppConfig): StoreKitDeploymentConfig {
  return {
    bundleId: appCfg.bundleId,
    allowedProductIds: Object.keys(appCfg.productMap),
    appAppleId: appCfg.appAppleId ?? undefined,
    allowSandbox: appCfg.allowSandbox && env.STOREKIT_ALLOW_SANDBOX === '1',
    onlineChecks: env.STOREKIT_ONLINE_CHECKS === '1',
    _verifiersForTests: verifierOverrideForTests?.(appCfg.bundleId),
  };
}
