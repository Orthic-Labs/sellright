// Generic runtime-artifact selection (de-fork Phase 5). Pure selection over the
// `runtime_artifact_promotion` current-pointer rows: artifact identity selectors,
// exact-target-over-any/any preference, fail-closed ambiguity, and lane-scoped
// entitlement. Suite policy (which app keys, which kinds, which lanes are
// licensed), envelope signature verification and R2 layout stay in the caller.
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import type { RuntimeArtifactPromotion } from '../db/schema-licensing.js';

export type RuntimeArtifactSelector =
  /** Identity-only selector: matches `artifact_id` exactly. */
  | { artifactId: string }
  /** Legacy selector: artifact id, exact current pointer key, or row UUID. */
  | { artifact: string };

export type RuntimeArtifactDelivery = 'private-r2' | 'public-r2' | 'bundled';

/** Lane a licence tier is entitled to. A pro licence may resolve private-r2 and
 *  public-r2 is only for public entitlement; bundled artifacts never resolve
 *  through the entitled path. */
const LANES_BY_TIER: Record<'pro' | 'public', readonly RuntimeArtifactDelivery[]> = {
  pro: ['private-r2', 'public-r2'],
  public: ['public-r2'],
};

export type RuntimeArtifactResolution =
  | { kind: 'ok'; promotion: RuntimeArtifactPromotion }
  | { kind: 'notfound' };

export interface ResolveRuntimeArtifactInput {
  storeId: string;
  appKey: string;
  selector: RuntimeArtifactSelector;
  target: { os: string; arch: string };
  /** Entitlement tier of the caller. Only lanes this tier may read are considered. */
  entitlementTier: 'pro' | 'public';
}

/**
 * Select the one current promotion for `selector` on `target`. Exact target wins
 * over any/any; an ambiguous match (the same selector on several rows at the same
 * target level, e.g. an id reused across kinds) fails closed as `notfound`.
 * Runs inside the caller's store-scoped transaction (RLS applies).
 */
export async function resolveRuntimeArtifactPromotion(
  tx: Tx,
  input: ResolveRuntimeArtifactInput,
): Promise<RuntimeArtifactResolution> {
  const lanes = LANES_BY_TIER[input.entitlementTier];
  const identity = 'artifactId' in input.selector
    ? eq(s.runtimeArtifactPromotion.artifactId, input.selector.artifactId)
    : or(
      eq(s.runtimeArtifactPromotion.artifactId, input.selector.artifact),
      eq(s.runtimeArtifactPromotion.pointerKey, input.selector.artifact),
      // Compare the UUID as text so a malformed selector is a 404, not a cast error.
      sql`${s.runtimeArtifactPromotion.id}::text = ${input.selector.artifact}`,
    );
  const forTarget = (os: string, arch: string) => tx.select().from(s.runtimeArtifactPromotion).where(and(
    eq(s.runtimeArtifactPromotion.storeId, input.storeId),
    eq(s.runtimeArtifactPromotion.appKey, input.appKey),
    identity,
    eq(s.runtimeArtifactPromotion.targetOs, os),
    eq(s.runtimeArtifactPromotion.targetArch, arch),
    inArray(s.runtimeArtifactPromotion.delivery, [...lanes]),
  )).limit(2);
  const exact = input.target.os === 'any' || input.target.arch === 'any'
    ? []
    : await forTarget(input.target.os, input.target.arch);
  const candidates = exact.length > 0 ? exact : await forTarget('any', 'any');
  if (candidates.length !== 1) return { kind: 'notfound' };
  const [promotion] = candidates;
  if (!promotion) return { kind: 'notfound' };
  if ('artifactId' in input.selector && promotion.artifactId !== input.selector.artifactId) return { kind: 'notfound' };
  return { kind: 'ok', promotion };
}
