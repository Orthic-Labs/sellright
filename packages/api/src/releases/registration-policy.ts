/**
 * Release registration policy host (defork plan 3.2).
 *
 * The engine owns `POST /v1/admin/apps/releases`. A plugin customises it by
 * supplying a `ReleaseRegistrationPolicy` on its `ApiPlugin.releaseRegistration`
 * field: which apps/channels it claims, an optional tenant-bound service
 * credential, and a validation hook. See docs/policies/RELEASE-REGISTRATION.md.
 */
import { isReleaseServiceToken } from '../licensing/release-auth.js';

export const RELEASE_REGISTRATION_ROUTE = { method: 'POST', path: '/v1/admin/apps/releases' } as const;

export interface ReleaseRegistrationBody {
  appKey: string;
  version: string;
  channel: string;
  platform?: string | null;
  manifest: unknown;
  artifacts?: Array<{ artifactKey: string; path: string; sha256?: string | null; sizeBytes?: number | null }>;
  /** Unknown extra keys (e.g. a signed artifact manifest) are passed through to the hook untouched. */
  [extra: string]: unknown;
}

export interface ReleaseServiceCredential {
  /** Lower/upper hex sha256 of the bearer token (64 hex chars). The token itself is never stored. */
  sha256: string;
  /** The single store (slug) this credential may publish into; also the default for a missing x-store-slug. */
  storeSlug: string;
}

export interface ReleaseValidationContext {
  storeId: string;
  auth: 'admin' | 'service';
}

export interface ReleaseRegistrationPolicy {
  /** Claimed app keys. Omitted = catch-all (claims every app). Two policies may not overlap. */
  apps?: readonly string[];
  /** Allowed channels for claimed apps. Omitted = any channel. */
  channels?: readonly string[];
  /**
   * Same artifactKey already attached to another release: false/omitted (default, SellRight's
   * historical behaviour) keeps the existing download_artifact row; true repoints it to the
   * republished release (path, sha256, size_bytes). Applies to admin and service calls.
   */
  repointArtifacts?: boolean;
  /** Tenant-bound machine credential; only this policy's apps are publishable with it. */
  serviceCredential?: ReleaseServiceCredential;
  /**
   * Validate/normalise the request body. Throw (anything) to reject with
   * 400 `invalid release payload`. The returned body is what gets written; its
   * `appKey` must equal the input `appKey`.
   */
  validate?: (body: ReleaseRegistrationBody, ctx: ReleaseValidationContext) => ReleaseRegistrationBody | Promise<ReleaseRegistrationBody>;
}

export interface PolicyOwner {
  name: string;
  routes?: { routes: ReadonlyArray<{ method: string; path: string }> };
  releaseRegistration?: ReleaseRegistrationPolicy;
}

const SHA256_HEX = /^[0-9a-f]{64}$/i;

function overlaps(a: ReleaseRegistrationPolicy, b: ReleaseRegistrationPolicy): string | null {
  if (!a.apps || !b.apps) return '(catch-all)';
  return a.apps.find((app) => b.apps!.includes(app)) ?? null;
}

/**
 * Startup conflict check. Throws when two plugins claim the same app, share a
 * credential, mount the same method+path, or mount the host-owned release route.
 */
export function assertNoReleaseRegistrationConflicts(plugins: readonly PolicyOwner[]): void {
  const owners = plugins.filter((p) => p.releaseRegistration);
  for (const p of owners) {
    const cred = p.releaseRegistration!.serviceCredential;
    if (cred && (!SHA256_HEX.test(cred.sha256) || !cred.storeSlug)) {
      throw new Error(`plugin "${p.name}": invalid release service credential (needs 64-hex sha256 and storeSlug)`);
    }
    if (p.releaseRegistration!.apps?.length === 0) {
      throw new Error(`plugin "${p.name}": release registration claims an empty app list`);
    }
  }
  for (let i = 0; i < owners.length; i++) {
    for (let j = i + 1; j < owners.length; j++) {
      const a = owners[i]!;
      const b = owners[j]!;
      const hit = overlaps(a.releaseRegistration!, b.releaseRegistration!);
      if (hit) throw new Error(`release registration conflict: plugins "${a.name}" and "${b.name}" both claim app ${hit}`);
      const ca = a.releaseRegistration!.serviceCredential?.sha256.toLowerCase();
      const cb = b.releaseRegistration!.serviceCredential?.sha256.toLowerCase();
      if (ca && ca === cb) throw new Error(`release registration conflict: plugins "${a.name}" and "${b.name}" share a service credential`);
    }
  }
  const seen = new Map<string, string>();
  for (const p of plugins) {
    for (const r of p.routes?.routes ?? []) {
      if (r.method === 'ALL') continue; // middleware, not a route claim
      const key = `${r.method.toUpperCase()} ${r.path}`;
      if (key === `${RELEASE_REGISTRATION_ROUTE.method} ${RELEASE_REGISTRATION_ROUTE.path}`) {
        throw new Error(`route conflict: plugin "${p.name}" mounts ${key}, which is owned by the engine release registration host`);
      }
      const prior = seen.get(key);
      if (prior && prior !== p.name) throw new Error(`route conflict: plugins "${prior}" and "${p.name}" both mount ${key}`);
      seen.set(key, p.name);
    }
  }
}

export interface ResolvedPolicies {
  /** True when at least one plugin registered a policy (apps then act as an allow-list). */
  active: boolean;
  /** The policy claiming this app, or undefined. */
  forApp(appKey: string): ReleaseRegistrationPolicy | undefined;
  /** The policy whose credential matches this Authorization header. */
  forCredential(authorization: string | undefined): ReleaseRegistrationPolicy | undefined;
}

export function resolvePolicies(plugins: readonly PolicyOwner[]): ResolvedPolicies {
  const policies = plugins.flatMap((p) => (p.releaseRegistration ? [p.releaseRegistration] : []));
  return {
    active: policies.length > 0,
    forApp: (appKey) => policies.find((p) => !p.apps || p.apps.includes(appKey)),
    forCredential: (authorization) =>
      policies.find((p) => p.serviceCredential && isReleaseServiceToken(authorization, p.serviceCredential.sha256)),
  };
}

type RouteTable = { routes: ReadonlyArray<{ method: string; path: string }> };

/** Number of route-table entries (handlers + validator middleware) bound to the host-owned route. */
export function hostRouteEntryCount(app: RouteTable): number {
  return app.routes.filter((r) => r.path === RELEASE_REGISTRATION_ROUTE.path && (r.method === 'POST' || r.method === 'ALL')).length;
}

/**
 * Post-`init()` check: the host-owned route's entry count must be unchanged
 * since the host mounted it. Catches a plugin registering POST (or ALL) on it
 * from inside `init(app)`.
 */
export function assertHostRouteUnshadowed(app: RouteTable, countAtMount: number): void {
  if (hostRouteEntryCount(app) !== countAtMount) {
    throw new Error(`route conflict: ${RELEASE_REGISTRATION_ROUTE.method} ${RELEASE_REGISTRATION_ROUTE.path} is owned by the engine release registration host; a plugin registered it again (probably in init())`);
  }
}
