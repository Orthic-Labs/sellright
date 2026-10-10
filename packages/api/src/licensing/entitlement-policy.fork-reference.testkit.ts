/**
 * Reference implementation of the RightSites fork's entitlement behaviour as an
 * EntitlementPolicy (plan 3.6 "fork behaviour reproducible via the policy").
 *
 * TEST KIT ONLY — it is not imported by engine code. It exists to prove, in
 * this repository, that every fork rule in COMPAT C10-C12 maps onto the policy
 * seams; the plugin's real policy is written against the same interface, with
 * `validUpgrade` bound to `licensing/heardright-mobile-upgrade#validUpgradeLicense`
 * and `trialDaysForPlatform` / `TrialPlatform` moved here from `licensing/trial`
 * (IMPORT-DISPOSITION: moved). Mapping table: docs/policies/ENTITLEMENTS.md.
 */
import { z } from '@hono/zod-openapi';
import type { Tx } from '../db/client.js';
import { isSandboxStoreKitLicense } from './storekit-license.js';
import {
  ALLOW, DENY_NOTFOUND, denyPlatform,
  type AuthorizeContext, type EntitlementPolicy, type PolicyDecision,
} from './entitlement-policy.js';
import { TRIAL_DAYS } from './trial.js';

export const MAC_TRIAL_DAYS = 30;
export type TrialPlatform = 'macos' | 'windows' | 'ios';

export function trialDaysForPlatform(platform?: TrialPlatform): number {
  return platform === 'macos' ? MAC_TRIAL_DAYS : TRIAL_DAYS;
}

export const WATCH_REASON = 'deviceClass "watch" is not accepted on this endpoint — the Watch app never activates a license directly.';
export const MOBILE_ONLY_REASON = 'Mobile Pro authorizes iPhone & iPad only; Full Pro is required for computers.';
export const SANDBOX_WINDOWS_LINK_REASON =
  'this Pro license originates from a Sandbox (TestFlight) purchase and cannot link a Windows computer activation';

type Scope = 'mobile' | 'full';
export function forkEntitlementScope(appKey: string, metadata: unknown): Scope {
  return appKey === 'heardright' && metadata != null && typeof metadata === 'object'
    && (metadata as Record<string, unknown>).entitlement_scope === 'mobile' ? 'mobile' : 'full';
}
const scopeAllowsPlatform = (scope: Scope, platform: string) => scope === 'full' || platform === 'ios' || platform === 'ipados';

export interface ForkReferenceOptions {
  /** Binds heardright-mobile-upgrade#validUpgradeLicense in the real plugin. Default: always valid. */
  validUpgrade?: (tx: Tx, appKey: string, metadata: unknown) => Promise<boolean>;
}

export function forkReferencePolicy(opts: ForkReferenceOptions = {}): EntitlementPolicy {
  const validUpgrade = opts.validUpgrade ?? (async () => true);
  return {
    id: 'rightsites-fork-reference',
    // COMPAT G06: schema failures surface as 500 on the legacy wire.
    invalidExtension: 'internal',
    // activation-guards (suite-policies.ts:49): runs right after body parse, before rate limit / store / DB.
    // The route maps this to HttpError(400, message); the legacy-error-shape plugin then yields the golden bytes.
    preRoute(ctx) {
      if (ctx.ext.deviceClass === 'watch') {
        return { status: 400, message: WATCH_REASON };
      }
    },
    requestExtensions: {
      // activation-guards: a Watch never activates independently (suite-policies.ts:49).
      activate: z.object({ deviceClass: z.enum(['mac', 'windows', 'iphone', 'android', 'watch']).optional() }),
      trial: z.object({ platform: z.enum(['macos', 'windows', 'ios']).optional() }),
    },
    async authorize(ctx: AuthorizeContext): Promise<PolicyDecision> {
      const { license: lic } = ctx;
      const sandbox = isSandboxStoreKitLicense(lic.metadata);
      const scope = forkEntitlementScope(lic.appKey, lic.metadata);
      switch (ctx.path) {
        case 'activate':
        case 'refresh':
        case 'update_feed':
          // activations.ts:92 / :220 — sandbox-origin, mobile scope, invalid upgrade => as-if-unknown
          if (sandbox || scope === 'mobile' || !await validUpgrade(ctx.tx, lic.appKey, lic.metadata)) return DENY_NOTFOUND;
          return ALLOW;
        case 'lease_issue':
        case 'storekit_link': // fork routes link-storekit through issueDeviceLease (rightsites storekit-webhooks.ts:222)
          // device-leases.ts:125-129
          if (!await validUpgrade(ctx.tx, lic.appKey, lic.metadata)) return DENY_NOTFOUND;
          if ((sandbox && ctx.pool === 'computer') || !scopeAllowsPlatform(scope, ctx.platform ?? '')) {
            return denyPlatform(MOBILE_ONLY_REASON);
          }
          return ALLOW;
        case 'lease_renew':
          // device-leases.ts:293-294
          if (!await validUpgrade(ctx.tx, lic.appKey, lic.metadata)) return DENY_NOTFOUND;
          if ((sandbox && ctx.pool === 'computer') || (scope === 'mobile' && ctx.pool !== 'mobile')) return DENY_NOTFOUND;
          return ALLOW;
        case 'windows_link':
          // pro-devices.ts:378 / windows-link.ts:87
          return sandbox ? denyPlatform(SANDBOX_WINDOWS_LINK_REASON) : ALLOW;
        default:
          return ALLOW;
      }
    },
    // device-leases.ts:135 — HeardRight mobile is unlimited today although the policy declares 2.
    leaseUnlimited: (ctx) => ctx.license.appKey === 'heardright' && ctx.pool === 'mobile',
    // device-leases.ts:230/239/307/316 — scope claim only when mobile.
    claims: (ctx) => (forkEntitlementScope(ctx.license.appKey, ctx.license.metadata) === 'mobile' ? { entitlementScope: 'mobile' } : undefined),
    // routes/apps.ts:318, :374-379 — only HeardRight uses the platform; persisted platform decides resend.
    trial(ctx) {
      const platform = (ctx.ext.platform as TrialPlatform | undefined);
      if (ctx.outcome === 'resend') {
        const prior = (ctx.priorMetadata as { platform?: TrialPlatform } | null)?.platform;
        return { days: ctx.appKey === 'heardright' ? trialDaysForPlatform(prior) : TRIAL_DAYS };
      }
      return {
        days: ctx.appKey === 'heardright' ? trialDaysForPlatform(platform) : TRIAL_DAYS,
        metadata: { platform: platform ?? null }, // routes/apps.ts:394 (written for every app)
      };
    },
  };
}
