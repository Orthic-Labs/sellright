// StoreKit policy contract (de-fork plan 3.5; STOREKIT.md §3).
//
// The engine owns routing, JWS verification, operation claims, lock planning and
// HTTP mapping. A policy supplies the app-specific decisions at fixed hooks:
//   validateLink      pre-transaction; may verify paired proofs (network), no DB writes
//   decideMaterialize notification path, after a 'no_purchase' apply
//   issue             inside the locked transaction; only through HeldLocks
//   cascade           inside the locked transaction, before the notification apply
//   respond           pure mapping of every link outcome to one HTTP result
// Exactly one policy serves each appKey; one policy with no appKeys is the fallback.
import type { Tx } from '../../db/client.js';
import type { HeldLocks, PurchaseId } from '../../db/locks.js';
import type { StoreKitAppConfig, StoreKitProductEntitlement } from '../storekit-config.js';
import type { StoreKitTransactionPayload, VerifyStoreKitResult } from '../storekit-verify.js';
import type { VerifiedStoreKitLicenseSource } from '../storekit-license.js';
import type { ZodType } from 'zod';
import type { LockPlanContribution, LockSubject } from '../../db/locks.js';
import { registerLockPlanContributor } from '../../db/locks.js';

export interface VerifiedProofSet {
  readonly primary: StoreKitTransactionPayload;
  /** Second, paired proof (e.g. a mobile purchase backing an upgrade), if the policy verified one. */
  readonly paired: StoreKitTransactionPayload | null;
}

export interface LinkRequest {
  readonly appKey: string;
  readonly signedTransactionInfo: string;
  readonly deviceIdHash: string;
  readonly platform?: 'macos' | 'windows' | 'ios' | 'ipados' | 'watchos' | 'android';
  readonly deviceLabel?: string;
  /** Policy-declared request fields, already validated by the policy's zod extension. */
  readonly extensions: Readonly<Record<string, unknown>>;
}

export interface ValidateLinkInput {
  readonly storeId: string;
  readonly appCfg: StoreKitAppConfig;
  readonly request: LinkRequest;
  readonly primary: StoreKitTransactionPayload;
  readonly customerId: string;
  readonly verifyPaired: (jws: string) => Promise<VerifyStoreKitResult>;
}

export type LinkValidation =
  | { readonly ok: true; readonly proofs: VerifiedProofSet; readonly facts: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly status: 400 | 401 | 409 | 422; readonly message: string };

export interface DecideMaterializeInput {
  readonly appCfg: StoreKitAppConfig;
  readonly action: 'revoke' | 'restore' | 'renew' | 'expire';
  readonly productId: string | null;
  readonly environment: string;
  readonly purchase: PurchaseId;
}

export type MaterializeDecision =
  | { readonly materialize: false }
  | { readonly materialize: true; readonly entitlement: StoreKitProductEntitlement | null };

export interface DeviceContext {
  readonly deviceIdHash: string;
  readonly platform: string | null;
  readonly label: string | null;
}

export type IssueInput =
  | {
      readonly purpose: 'materialize';
      readonly storeId: string;
      readonly appCfg: StoreKitAppConfig;
      readonly source: VerifiedStoreKitLicenseSource;
      readonly entitlement: StoreKitProductEntitlement | null;
    }
  | {
      readonly purpose: 'link';
      readonly storeId: string;
      readonly appCfg: StoreKitAppConfig;
      readonly proofs: VerifiedProofSet;
      readonly customerId: string;
      readonly entitlement: StoreKitProductEntitlement | null;
      readonly device: DeviceContext;
      readonly facts: Readonly<Record<string, unknown>>;
    };

export type Credential = {
  readonly kind: 'activation';
  readonly activationId: string;
  readonly deviceIdHash: string;
  readonly activatedAt: Date | string | null;
  readonly activationToken: string;
  readonly lic: { id: string; expiresAt: Date | null; metadata: unknown };
};

export type IssueResult =
  | {
      readonly kind: 'ok';
      readonly license: { readonly id: string; readonly licenseKey: string };
      readonly entitlement: StoreKitProductEntitlement | null;
      readonly credential: Credential | null;
      readonly disclosed: Readonly<Record<string, unknown>>;
    }
  | { readonly kind: 'account_conflict' }
  | { readonly kind: 'rejected'; readonly code: 'notfound' | 'seat_limit' | 'invalid_product' | 'mobile_source_required' | 'credit_used' | 'platform_rejected' };

export interface NotificationChange {
  readonly purchase: PurchaseId;
  readonly licenseId: string | null;
  readonly appKey: string;
  readonly action: 'revoke' | 'restore' | 'renew' | 'expire';
  readonly now: Date;
}

export interface CascadeResult {
  /** false: a restore does not un-tombstone activations (heardright, storekit-license.ts:478). */
  readonly restoreActivations: boolean;
}

export type LinkOutcome =
  | { readonly kind: 'no_config' }
  | { readonly kind: 'verify_failed'; readonly reason: Exclude<VerifyStoreKitResult['kind'], 'ok'> }
  | { readonly kind: 'unauth' }
  | { readonly kind: 'validation'; readonly status: 400 | 401 | 409 | 422; readonly message: string }
  | { readonly kind: 'issued'; readonly result: Extract<IssueResult, { kind: 'ok' }>; readonly deviceIdHash: string; readonly deviceLabel: string | null }
  | { readonly kind: 'issue_rejected'; readonly result: Exclude<IssueResult, { kind: 'ok' }> }
  | { readonly kind: 'lock_unstable' };

export type HttpResult =
  | { readonly status: 200; readonly body: Record<string, unknown> }
  | { readonly status: 400 | 401 | 409 | 422 | 503; readonly message: string };

export interface StoreKitPolicy {
  readonly id: string;
  /** appKeys this policy serves. Omitted = the fallback policy (at most one). */
  readonly appKeys?: readonly string[];
  /** Zod shape merged into the link request. Parsed per request; failures are a 400 validation outcome. */
  readonly linkRequestExtension?: Readonly<Record<string, ZodType>>;
  /** Zod shape describing extra link response fields. Documentation/OpenAPI shape; respond() owns the body. */
  readonly linkResponseExtension?: Readonly<Record<string, ZodType>>;
  validateLink(i: ValidateLinkInput): Promise<LinkValidation>;
  decideMaterialize(i: DecideMaterializeInput): MaterializeDecision;
  /** Extra dependent licences/orders to lock with a subject (STOREKIT §5.3). Runs unlocked and again under the locks. */
  lockPlan?(tx: Tx, subject: LockSubject): Promise<LockPlanContribution>;
  issue(tx: Tx, held: HeldLocks, i: IssueInput): Promise<IssueResult>;
  cascade?(tx: Tx, held: HeldLocks, c: NotificationChange): Promise<CascadeResult>;
  respond(o: LinkOutcome): HttpResult;
}

const byAppKey = new Map<string, StoreKitPolicy>();
let fallback: StoreKitPolicy | null = null;

/** Register a policy. Startup error on a second policy for one appKey or a second fallback. */
export function registerStoreKitPolicy(p: StoreKitPolicy): void {
  if (!p.appKeys) {
    if (fallback) throw new Error(`StoreKit fallback policy already registered (${fallback.id}); cannot register ${p.id}`);
    fallback = p;
    return;
  }
  for (const k of p.appKeys) {
    const existing = byAppKey.get(k);
    if (existing) throw new Error(`StoreKit appKey "${k}" already served by policy ${existing.id}; cannot register ${p.id}`);
  }
  for (const k of p.appKeys) byAppKey.set(k, p);
}

/** The registered fallback policy, if any. */
export function storeKitFallbackPolicy(): StoreKitPolicy | null {
  return fallback;
}

/** Policy serving an appKey: its own registration, else the fallback. */
export function storeKitPolicyFor(appKey: string): StoreKitPolicy {
  const p = byAppKey.get(appKey) ?? fallback;
  if (!p) throw new Error('no StoreKit policy registered (sellright-default must be installed)');
  return p;
}

/** Test seam: drop every registration. Callers re-register what they need. */
export function _resetStoreKitPoliciesForTests(): void {
  byAppKey.clear();
  fallback = null;
}

function registeredPolicies(): StoreKitPolicy[] {
  const all = new Set<StoreKitPolicy>(byAppKey.values());
  if (fallback) all.add(fallback);
  return [...all];
}

// Every registered policy's lockPlan joins the engine's plan (STOREKIT §5.3, plan plus union).
registerLockPlanContributor(async (tx, subject) => {
  let out: LockPlanContribution = { purchases: [], licenseIds: [], orderIds: [] };
  for (const p of registeredPolicies()) {
    if (!p.lockPlan) continue;
    const c = await p.lockPlan(tx, subject);
    out = {
      purchases: [...out.purchases, ...c.purchases],
      licenseIds: [...out.licenseIds, ...c.licenseIds],
      orderIds: [...out.orderIds, ...c.orderIds],
    };
  }
  return out;
});
