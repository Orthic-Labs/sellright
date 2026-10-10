/**
 * Entitlement authorization policy (de-fork plan 3.6).
 *
 * ONE policy interface, consulted by EVERY path that grants or refreshes an
 * entitlement:
 *
 *   activate        activateLicenseOnDevice  (/api/licenses/activate, /v1/licenses/activate,
 *                                              /v1/apps/{appKey}/licenses/activate)
 *   refresh         findActivationByToken    (/api/licenses/refresh, /v1/licenses/refresh)
 *   update_feed     findActivationByToken    (releases/latest.json and plugin update feeds)
 *   lease_issue     issueDeviceLease
 *   lease_renew     renewDeviceLease
 *   trial_start     POST /{api,v1}/licenses/trial, fresh trial
 *   trial_resend    POST /{api,v1}/licenses/trial, existing valid trial
 *   storekit_link  POST /v1/shop/pro/link-storekit (issueStoreKitActivation)
 *   windows_link    plugin-owned Windows link request (consults the same policy)
 *
 * The engine owns the decision POINTS; a downstream plugin owns the decision
 * VALUES (sandbox rules, platform scopes, trial durations, upgrade validity).
 * Nothing registered (the default) reproduces the pre-policy engine exactly:
 * every authorization is `allow`, trials last TRIAL_DAYS, no extra claims.
 *
 * Registration mirrors registerDevicePolicy / registerTierCatalog /
 * registerEntitlementProvider: an in-memory singleton set once at boot.
 *
 * `authorize` runs INSIDE the caller's store-scoped transaction (it receives
 * `tx`), so a policy may read rows (e.g. upgrade-order validity) under the same
 * row locks as the grant. A policy may also throw `EntitlementVeto`; on the
 * paths that run under `withEntitlementVeto` the transaction rolls back and the
 * veto becomes the route response.
 */
import { z } from '@hono/zod-openapi';
import type { Tx } from '../db/client.js';
import { HttpError } from '../routes/admin-helpers.js';
import { TRIAL_DAYS } from './trial.js';

export const ENTITLEMENT_PATHS = [
  'activate',
  'refresh',
  'update_feed',
  'lease_issue',
  'lease_renew',
  'trial_start',
  'trial_resend',
  'storekit_link',
  'windows_link',
] as const;
export type EntitlementPath = (typeof ENTITLEMENT_PATHS)[number];

/** Paths whose request body may carry policy-declared typed extensions. */
export const EXTENSION_PATHS = ['activate', 'refresh', 'lease_issue', 'trial'] as const;
export type ExtensionPath = (typeof EXTENSION_PATHS)[number];

/** Request extensions after validation against the policy's zod schema. */
export type RequestExtensions = Readonly<Record<string, unknown>>;

export interface PolicyLicense {
  id: string;
  appKey: string;
  status: string;
  seats: number;
  expiresAt: Date | null;
  metadata: unknown;
}

/**
 * `notfound`: the caller sees the same outcome as an unknown/inactive license.
 * `rejected_platform`: an explicit, user-visible rejection with a reason (lease
 * issue returns it as 400; activate returns it as 400 `rejected_platform`; the
 * paths that cannot carry a reason — refresh, update_feed, lease_renew — treat
 * it exactly like `notfound`).
 */
export type PolicyDecision =
  | { allow: true }
  | { allow: false; kind: 'notfound' }
  | { allow: false; kind: 'rejected_platform'; reason: string };

export const ALLOW: PolicyDecision = Object.freeze({ allow: true as const });
export const DENY_NOTFOUND: PolicyDecision = Object.freeze({ allow: false as const, kind: 'notfound' as const });
export function denyPlatform(reason: string): PolicyDecision {
  return { allow: false, kind: 'rejected_platform', reason };
}

export interface AuthorizeContext {
  path: EntitlementPath;
  tx: Tx;
  storeId: string;
  license: PolicyLicense;
  /** Requested platform (lease_issue, windows_link). */
  platform?: string;
  /** Derived pool (lease_issue) or the stored pool of the activation (lease_renew, refresh). */
  pool?: string | null;
  ext: RequestExtensions;
  now: Date;
}

/** Additive claims the policy asks the signer to embed. Order and names are frozen in sign.ts. */
export interface PolicyClaims {
  entitlementScope?: 'mobile' | 'full';
}

export interface ClaimsContext {
  path: EntitlementPath;
  license: Pick<PolicyLicense, 'appKey' | 'metadata'>;
  pool?: string | null;
}

export interface CapacityContext {
  path: 'lease_issue';
  license: Pick<PolicyLicense, 'appKey' | 'seats' | 'metadata'>;
  pool: string;
}

export interface TrialContext {
  storeId: string;
  appKey: string;
  email: string;
  outcome: 'start' | 'resend';
  /** metadata persisted on the existing trial license (resend only). */
  priorMetadata: unknown;
  ext: RequestExtensions;
  now: Date;
}

export interface TrialDecision {
  /** Trial length in days. For a resend this is the length reported to the user. */
  days: number;
  /** Merged AFTER `{tier:'pro', kind:'trial'}` into the minted license metadata (start only). */
  metadata?: Record<string, unknown>;
}

/** Typed pre-route rejection; the route maps it to `HttpError(status, message, code)`. */
export interface PolicyRejection {
  status: 400 | 403;
  message: string;
  /** Defaults to the HttpError-derived code (slug of the message), as legacy guards did. */
  code?: string;
}

export interface PreRouteContext {
  path: 'activate';
  rawBody: unknown;
  ext: RequestExtensions;
  header: (name: string) => string | undefined;
}

export interface EntitlementPolicy {
  id: string;
  /**
   * How an invalid typed extension surfaces. 'bad_request' (default): 400
   * INVALID_REQUEST. 'internal': rethrow the ZodError so the app's generic
   * handler answers 500, exactly like a base-schema failure (the legacy wire).
   */
  invalidExtension?: 'bad_request' | 'internal';
  /**
   * Runs right after the body is parsed and BEFORE the rate limiter, store
   * resolution and any DB work on every activate route. Return a rejection to
   * refuse; nothing is recorded or looked up (legacy deviceClass guard order).
   */
  preRoute?(ctx: PreRouteContext): PolicyRejection | void;
  /** Typed request extensions: zod schemas applied to the raw JSON body of the named handler. */
  requestExtensions?: Partial<Record<ExtensionPath, z.ZodType<Record<string, unknown>>>>;
  /** Grant/refresh authorization for every path except trials. Default: allow. */
  authorize?(ctx: AuthorizeContext): PolicyDecision | Promise<PolicyDecision>;
  /** Extra signed claims for the entitlement token / lease envelope. Default: none. */
  claims?(ctx: ClaimsContext): PolicyClaims | undefined;
  /** Return true to bypass the per-pool lease cap for this license+pool. Default: false. */
  leaseUnlimited?(ctx: CapacityContext): boolean;
  /** Trial duration and persisted metadata. Default: TRIAL_DAYS, no extra metadata. */
  trial?(ctx: TrialContext): TrialDecision;
}

export const DEFAULT_ENTITLEMENT_POLICY: EntitlementPolicy = Object.freeze({ id: 'default' });

let active: EntitlementPolicy | null = null;

export function registerEntitlementPolicy(policy: EntitlementPolicy): void {
  active = policy;
}

/** Test/deploy seam. */
export function clearEntitlementPolicy(): void {
  active = null;
}

export function entitlementPolicy(): EntitlementPolicy {
  return active ?? DEFAULT_ENTITLEMENT_POLICY;
}

/** Run the pre-route seam; throws the mapped HttpError on rejection. */
export function enforcePreRoute(ctx: PreRouteContext): void {
  const r = entitlementPolicy().preRoute?.(ctx);
  if (r) throw new HttpError(r.status, r.message, r.code);
}

/** Consult the policy for a grant/refresh decision. */
export async function authorizeEntitlement(ctx: AuthorizeContext): Promise<PolicyDecision> {
  return (await entitlementPolicy().authorize?.(ctx)) ?? ALLOW;
}

/** Claims the signer must embed for this license (frozen order lives in sign.ts). */
export function policyClaims(ctx: ClaimsContext): PolicyClaims {
  return entitlementPolicy().claims?.(ctx) ?? {};
}

export function policyLeaseUnlimited(ctx: CapacityContext): boolean {
  return entitlementPolicy().leaseUnlimited?.(ctx) === true;
}

export function policyTrial(ctx: TrialContext): TrialDecision {
  return entitlementPolicy().trial?.(ctx) ?? { days: TRIAL_DAYS };
}

/**
 * Validate the policy's typed extension for a handler against the raw body.
 * No policy / no schema for this handler => `{}` (the base schema's own
 * parse already ran; unknown keys stay ignored exactly as before). An invalid
 * extension is a 400 `HttpError` (the base schemas' own ZodError is flattened
 * to 500 by the app error handler; a typed extension rejects cleanly instead).
 */
export function parseRequestExtensions(path: ExtensionPath, raw: unknown): RequestExtensions {
  const schema = entitlementPolicy().requestExtensions?.[path];
  if (!schema) return Object.freeze({});
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    if (entitlementPolicy().invalidExtension === 'internal') throw parsed.error;
    const first = parsed.error.issues[0];
    throw new HttpError(400, `invalid request: ${first?.path.join('.') || 'body'} ${first?.message ?? ''}`.trim(), 'INVALID_REQUEST');
  }
  return Object.freeze({ ...parsed.data });
}
