// Generic per-app device policy registry. The licensing ENGINE lives here;
// every suite value (which apps use bounded device pools, what the pool caps
// are, lease windows, platform→pool overrides) is registered by the deployer —
// from store config or product metadata — never hardcoded against a specific
// app in this module.

export type ActivationPool = 'computer' | 'mobile' | 'companion' | (string & {});

/** Generic OS taxonomy the engine understands. Suites pick from this list or
 *  add their own via policy.platformPools. */
export const KNOWN_PLATFORMS = ['macos', 'windows', 'linux', 'ios', 'ipados', 'android', 'watchos'] as const;
export type KnownPlatform = (typeof KNOWN_PLATFORMS)[number];

const KNOWN = new Set<string>(KNOWN_PLATFORMS);

export const DEFAULT_PLATFORM_POOL: Record<KnownPlatform, ActivationPool> = {
  macos: 'computer',
  windows: 'computer',
  linux: 'computer',
  ios: 'mobile',
  ipados: 'mobile',
  android: 'mobile',
  watchos: 'companion',
};

export interface DevicePolicy {
  /** Marker written into license.metadata.device_policy at issuance. Absence on
   *  an older seats<=0 license is the grandfathering signal; never infer a
   *  bounded license from its creation date. */
  marker: string;
  /** Max ACTIVE devices per pool. A pool missing here is uncapped. */
  poolCaps?: Partial<Record<ActivationPool, number>>;
  /** Pools whose platforms may hold a lease directly. Default: every pool
   *  EXCEPT 'companion' — a companion (watch-class) device receives entitlement
   *  from a paired device and can never be used to dodge a seat. */
  leasablePools?: readonly ActivationPool[];
  /** Issue new licenses with seats=0 so pool caps — not the flat seat count —
   *  are authoritative. */
  pooledSeats?: boolean;
  /** platform → pool overrides / extensions (e.g. { tvos: 'living_room' }). */
  platformPools?: Record<string, ActivationPool>;
  /** Rolling lease lifetime, default 7 days. */
  leaseTtlSeconds?: number;
  /** Offline grace beyond lease expiry, default 14 days. */
  leaseGraceSeconds?: number;
  /** Trusted server-side activation-source → stored class+pool for the legacy
   *  activate path. `pool` is server-derived, never client-supplied. */
  activationSources?: Record<string, { deviceClass: string; pool: ActivationPool }>;
}

const policies = new Map<string, DevicePolicy>();

export function registerDevicePolicy(appKey: string, policy: DevicePolicy): void {
  policies.set(appKey, policy);
}

/** Test/deploy seam: drop every registered policy. */
export function clearDevicePolicies(): void {
  policies.clear();
}

export function devicePolicyFor(appKey: string): DevicePolicy | null {
  return policies.get(appKey) ?? null;
}

export const DEFAULT_LEASE_TTL_SECONDS = 7 * 86_400;
export const DEFAULT_LEASE_GRACE_SECONDS = 14 * 86_400;
const DEFAULT_LEASABLE_POOLS: readonly ActivationPool[] = ['computer', 'mobile'];
const DEFAULT_ACTIVATION_SOURCES: Record<string, { deviceClass: string; pool: ActivationPool }> = {
  desktop: { deviceClass: 'desktop', pool: 'computer' },
};

function metadataRecord(metadata: unknown): Record<string, unknown> {
  return metadata != null && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
}

/** Stamp the app's current policy marker onto license metadata at issuance. */
export function withCurrentDevicePolicy(appKey: string, metadata: unknown): unknown {
  const policy = devicePolicyFor(appKey);
  if (!policy) return metadata;
  return { ...metadataRecord(metadata), device_policy: policy.marker };
}

export function hasCurrentDevicePolicy(appKey: string, metadata: unknown): boolean {
  const policy = devicePolicyFor(appKey);
  return policy != null && metadataRecord(metadata).device_policy === policy.marker;
}

/** Earlier unlimited (seats<=0, unmarked) licenses remain unlimited.
 *  Positive-seat licenses and marked licenses go through bounded enforcement. */
export function usesBoundedDevicePools(appKey: string, seats: number, metadata: unknown): boolean {
  if (!devicePolicyFor(appKey)) return false;
  return seats > 0 || hasCurrentDevicePolicy(appKey, metadata);
}

export function isKnownPlatform(platform: string): boolean {
  return KNOWN.has(platform);
}

/** platform → pool, honoring per-app overrides. null = unknown platform. */
export function derivePool(appKey: string, platform: string): ActivationPool | null {
  const override = devicePolicyFor(appKey)?.platformPools?.[platform];
  if (override) return override;
  return (DEFAULT_PLATFORM_POOL as Record<string, ActivationPool>)[platform] ?? null;
}

export function poolCap(appKey: string, pool: ActivationPool): number {
  return devicePolicyFor(appKey)?.poolCaps?.[pool] ?? Number.POSITIVE_INFINITY;
}

export function leasablePool(appKey: string, pool: ActivationPool): boolean {
  return (devicePolicyFor(appKey)?.leasablePools ?? DEFAULT_LEASABLE_POOLS).includes(pool);
}

export function leaseTtlSecondsFor(appKey: string): number {
  return devicePolicyFor(appKey)?.leaseTtlSeconds ?? DEFAULT_LEASE_TTL_SECONDS;
}

export function leaseGraceSecondsFor(appKey: string): number {
  return devicePolicyFor(appKey)?.leaseGraceSeconds ?? DEFAULT_LEASE_GRACE_SECONDS;
}

/** Trusted route/proof → stored device class + pool for the legacy activate
 *  path. Only defined for apps with a registered policy; returns null for
 *  unregistered apps so their rows stay unclassified. */
export function activationSourceDefaults(
  appKey: string,
  source: string,
): { deviceClass: string; pool: ActivationPool } | null {
  const policy = devicePolicyFor(appKey);
  if (!policy) return null;
  return (policy.activationSources ?? DEFAULT_ACTIVATION_SOURCES)[source] ?? null;
}
