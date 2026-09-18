export type FulfillmentType = 'physical' | 'digital_download' | 'license' | 'update_pass';

export interface LicenseGrantInput {
  orderLineId: string;
  quantity: number;
  fulfillmentType: FulfillmentType;
  appKey: string | null;
  licenseSeats: number | null;
  updatesDurationDays: number | null;
  licenseDurationDays: number | null;
  metadata: unknown;
}

export interface LicenseGrant {
  orderLineId: string;
  appKey: string;
  seats: number;
  expiresAt: Date | null;
  updatesUntil: Date | null;
  metadata: unknown;
}

function addDays(d: Date, days: number | null): Date | null {
  if (days == null) return null;
  return new Date(d.getTime() + days * 86_400_000);
}

export function buildLicenseGrants(lines: LicenseGrantInput[], now = new Date()): LicenseGrant[] {
  const grants: LicenseGrant[] = [];
  for (const line of lines) {
    if (!['digital_download', 'license', 'update_pass'].includes(line.fulfillmentType) || !line.appKey) continue;
    for (let i = 0; i < line.quantity; i++) {
      grants.push({
        orderLineId: line.orderLineId,
        appKey: line.appKey,
        seats: line.licenseSeats ?? 1,
        expiresAt: addDays(now, line.licenseDurationDays),
        updatesUntil: addDays(now, line.updatesDurationDays),
        metadata: line.metadata,
      });
    }
  }
  return grants;
}

export function canReceiveUpdate(license: { status: string; updatesUntil: Date | null }, now = new Date()): boolean {
  // updatesUntil == null means perpetual/lifetime updates (a variant with
  // updatesDurationDays = null, e.g. a "Lifetime" plan) — mirrors canAccessDownload's
  // treatment of expiresAt == null. A time-limited update window sets a date.
  return license.status === 'active' && (license.updatesUntil == null || license.updatesUntil.getTime() >= now.getTime());
}

export function canAccessDownload(license: { status: string; expiresAt: Date | null }, now = new Date()): boolean {
  return license.status === 'active' && (license.expiresAt == null || license.expiresAt.getTime() >= now.getTime());
}

// ── Unified entitlement contract (shared across every licensed app) ─────────
// VERSIONED so the shape can evolve without breaking clients at once. Rule:
// additive-only — new fields are optional, `v` bumps ONLY on a breaking change,
// and clients ignore unknown fields (forward-compatible). The server is the
// single source of truth for what each tier unlocks; the app just reads features[].
export interface Entitlements {
  v: 1;
  tier: string | null;
  features: string[];
}

// Per-app tier catalogs are registered by the deployer (from store config /
// product metadata) — tier names, plan→tier aliases, and feature lists are
// suite values and are never hardcoded here.
export interface TierCatalog {
  /** metadata.tier value → authorization tier (e.g. a checkout plan whose name
   *  describes device allowance, not the shared authorization class). The
   *  original plan stays preserved in license metadata for support. */
  aliases?: Record<string, string>;
  /** authorization tier → feature list. */
  features?: Record<string, string[]>;
}

const tierCatalogs = new Map<string, TierCatalog>();

export function registerTierCatalog(appKey: string, catalog: TierCatalog): void {
  tierCatalogs.set(appKey, catalog);
}

/** Test/deploy seam: drop every registered catalog. */
export function clearTierCatalogs(): void {
  tierCatalogs.clear();
}

export function tierCatalogFor(appKey: string): TierCatalog | null {
  return tierCatalogs.get(appKey) ?? null;
}

/** Resolve a license's stored plan/tier to its authorization tier via the
 *  registered aliases. Unknown plans pass through unchanged. */
export function resolveAuthorizationTier(appKey: string | undefined, plan: string | null): string | null {
  if (plan == null) return null;
  const aliases = appKey ? tierCatalogFor(appKey)?.aliases : undefined;
  return aliases?.[plan] ?? plan;
}

/** Private/material feature updates are a tier entitlement, not merely an
 *  active update window. Keep this separate from `canReceiveUpdate`: public
 *  patches remain available to lower-tier installs through the public patch
 *  lane. `requiredTier` is the tier the update lane requires (e.g. 'pro'). */
export function canReceiveTieredUpdate(
  license: { status: string; updatesUntil: Date | null; expiresAt?: Date | null; appKey?: string; metadata: unknown },
  requiredTier: string,
  now = new Date(),
): boolean {
  if (!canReceiveUpdate(license, now)) return false;
  if (license.expiresAt != null && license.expiresAt.getTime() < now.getTime()) return false;
  if (!license.metadata || typeof license.metadata !== 'object' || Array.isArray(license.metadata)) return false;
  const tier = (license.metadata as Record<string, unknown>).tier;
  return resolveAuthorizationTier(license.appKey, typeof tier === 'string' ? tier : null) === requiredTier;
}

/** Derive the generic entitlement object from a license. `tier` comes from
 *  metadata.tier (set at mint/issue), resolved through the app's aliases;
 *  `features` is an explicit metadata.features[] if present, else expanded
 *  from the registered per-app tier catalog. */
export function buildEntitlements(license: { appKey: string; metadata: unknown }): Entitlements {
  const meta = (license.metadata ?? {}) as { tier?: string; features?: string[] };
  const tier = resolveAuthorizationTier(license.appKey, meta.tier ?? null);
  const features = Array.isArray(meta.features)
    ? meta.features
    : (tier ? tierCatalogFor(license.appKey)?.features?.[tier] : undefined) ?? [];
  return { v: 1, tier, features };
}
