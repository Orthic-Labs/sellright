/** Apple StoreKit surface — ported upstream from RightSites
 *  (routes/storekit-webhooks.ts + the link-storekit endpoint of
 *  routes/pro-devices.ts), genericized for multi-store:
 *
 *    POST /v1/webhooks/apple/storekit   — App Store Server Notifications v2.
 *      Signature-authenticated (Apple JWS), idempotent via processed_event,
 *      intentionally outside cookie CSRF (this path is neither /v1/shop nor
 *      /v1/admin and carries no session).
 *
 *    POST /v1/shop/pro/link-storekit    — client contract kept verbatim from
 *      RightSites so the existing iOS apps keep working: the app posts its
 *      Apple-signed transaction JWS, we verify it against the configured
 *      storekit_app row, mint/bind the license, and activate the device.
 *
 *  Tenant resolution is genericized: instead of a single env-configured app,
 *  the bundle id inside Apple's SIGNED payload selects the storekit_app row
 *  (bundle_id is globally unique there). Reading it unverified is a routing
 *  decision only — the JWS signature check that follows is what proves it.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { withStore, type Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { withLockedSet, LockSetUnstable, assertHeld, type PurchaseId } from '../db/locks.js';
import { customerToken, resolveCustomer } from '../auth/session.js';
import { clientIp } from '../auth/rate-limit.js';
import { recordStorekitVerifyFailure, storekitVerifyFailureRetryAfter } from './apps.limit.js';
import { errBody, guard, HttpError, J } from './admin-helpers.js';
import { resolveStoreFromCtx } from './store-context.js';
import { applyStoreKitNotification } from '../licensing/storekit-license.js';
import { storeKitNotificationAction } from '../licensing/storekit-notifications.js';
import {
  recordStoreKitEventDetached,
  recordStoreKitEventSafe,
  recordStoreKitVerifyFailureBounded,
  storeKitErrorText,
  storeKitLinkOperationId,
  storeKitNotificationOperationId,
  storeKitPayloadOperationId,
} from '../licensing/storekit-events.js';
import { verifyStoreKitNotificationForDeployment, verifyStoreKitTransactionForDeployment, type StoreKitTransactionPayload } from '../licensing/storekit-verify.js';
import {
  deploymentConfigFor,
  loadStoreKitAppByBundleId,
  loadStoreKitAppConfig,
  resolveStoreIdForStoreKitBundle,
  type StoreKitAppConfig,
} from '../licensing/storekit-config.js';
import { storeKitPolicyFor, type LinkOutcome, type HttpResult, type VerifiedProofSet } from '../licensing/storekit/policy.js';
import { installDefaultStoreKitPolicy } from '../licensing/storekit/default-policy.js';

export const storeKitWebhooks = new OpenAPIHono();

/** Read the bundle id out of an UNVERIFIED JWS payload for ROUTING ONLY —
 *  picking which configured app should verify it. Notification payloads carry
 *  `data.bundleId`; bare transaction payloads carry top-level `bundleId`.
 *  The value is never trusted: the subsequent signature verification either
 *  proves it or the request fails. */
function peekUnverifiedBundleId(jws: string): string | null {
  try {
    const parts = jws.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
    const data = payload.data;
    if (data && typeof data === 'object' && typeof (data as Record<string, unknown>).bundleId === 'string') {
      return (data as Record<string, string>).bundleId ?? null;
    }
    return typeof payload.bundleId === 'string' ? payload.bundleId : null;
  } catch {
    return null;
  }
}

// ── App Store Server Notifications v2 ───────────────────────────────────────

storeKitWebhooks.post('/v1/webhooks/apple/storekit', async (c) => {
  let signedPayload: string | undefined;
  try {
    const body = await c.req.json<{ signedPayload?: unknown }>();
    if (typeof body.signedPayload === 'string') signedPayload = body.signedPayload;
  } catch {
    return c.json({ error: 'malformed request' }, 400);
  }
  if (!signedPayload) return c.json({ error: 'missing signedPayload' }, 400);

  // Tenant selection: the signed bundle id picks the configured app. The
  // signature check below is what makes the claim trustworthy.
  const bundleId = peekUnverifiedBundleId(signedPayload);
  if (!bundleId) return c.json({ error: 'malformed payload' }, 400);
  const storeId = await resolveStoreIdForStoreKitBundle(bundleId);
  if (!storeId) return c.json({ error: 'unknown app' }, 400);
  const appCfg = await withStore(storeId, (tx) => loadStoreKitAppByBundleId(tx, storeId, bundleId));
  if (!appCfg) return c.json({ error: 'unknown app' }, 400);

  // De-fork 2.9: every stage is recorded in storekit_event. Verify rows use a
  // digest of the signed payload (the only identity that exists when
  // verification fails); apply/replay rows use the verified notificationUUID.
  const payloadOperationId = storeKitPayloadOperationId(signedPayload);
  const verified = await verifyStoreKitNotificationForDeployment(signedPayload, deploymentConfigFor(appCfg));
  if (verified.kind !== 'ok') {
    // Unauthenticated: bounded by payload digest (1/hr) and a per-(ip, app) budget.
    const ip = clientIp(c);
    await recordStoreKitVerifyFailureBounded(
      { storeId: appCfg.storeId, operationId: payloadOperationId, error: `verify:${verified.kind}` },
      async () => {
        if ((await storekitVerifyFailureRetryAfter(ip, appCfg.bundleId)) > 0) return false;
        await recordStorekitVerifyFailure(ip, appCfg.bundleId);
        return true;
      },
    );
  }
  if (verified.kind === 'retryable') return c.json({ error: 'notification verification temporarily unavailable' }, 503);
  if (verified.kind !== 'ok') return c.json({ error: 'notification verification failed' }, 400);
  await recordStoreKitEventDetached({ storeId: appCfg.storeId, operationId: payloadOperationId, stage: 'verify', outcome: 'ok' });
  const operationId = storeKitNotificationOperationId(verified.payload.notificationUUID);

  const p = verified.payload;
  const eventId = `apple-storekit:${p.notificationUUID}`;
  const claim = (tx: Tx) => tx.insert(s.processedEvent).values({
    id: eventId,
    storeId: appCfg.storeId,
    type: `apple.storekit.${p.notificationType}`,
  }).onConflictDoNothing().returning({ id: s.processedEvent.id });

  const action = storeKitNotificationAction(p.notificationType);
  const purchase: PurchaseId | null = p.originalTransactionId && verified.matchedEnvironment
    ? { storeId: appCfg.storeId, environment: String(verified.matchedEnvironment), originalTransactionId: p.originalTransactionId }
    : null;

  // Nothing to apply: only the claim (idempotency record) is written.
  if (action === 'ignore' || !purchase) {
    await withStore(appCfg.storeId, async (tx) => {
      const claimed = await claim(tx);
      // De-fork 2.9: a replay never resolves an apply failure; a first delivery concludes the operation.
      await recordStoreKitEventSafe(tx, {
        storeId: appCfg.storeId, operationId, stage: claimed.length === 0 ? 'replay' : 'apply', outcome: 'ok',
      });
    });
    return c.json({ received: true }, 200);
  }

  installDefaultStoreKitPolicy();
  const policy = storeKitPolicyFor(appCfg.appKey);
  const applyInput = {
    storeId: appCfg.storeId,
    action,
    environment: purchase.environment,
    originalTransactionId: purchase.originalTransactionId,
    transactionId: p.transactionId,
    notificationType: p.notificationType,
    notificationUUID: p.notificationUUID,
    expiresDate: p.expiresDate,
    revocationDate: p.revocationDate,
  };

  try {
    await withLockedSet(appCfg.storeId, { kind: 'notification', purchase }, async (tx, held, plan) => {
      // Idempotency: claim the notificationUUID inside the locked set. Apple
      // retries non-2xx, and a duplicate delivery must be a no-op.
      const claimed = await claim(tx);
      if (claimed.length === 0) {
        // Replay rows never resolve an apply failure (storekit-events.ts).
        await recordStoreKitEventSafe(tx, { storeId: appCfg.storeId, operationId, stage: 'replay', outcome: 'ok' });
        return;
      }
      await assertHeld(tx, held);

      const restoreActivations = policy.cascade
        ? (await policy.cascade(tx, held, { purchase, licenseId: plan.licenseIds[0] ?? null, appKey: appCfg.appKey, action, now: new Date() })).restoreActivations
        : true;
      let outcome = await applyStoreKitNotification(tx, applyInput, { restoreActivations });

      // A renewal/restore can legitimately reference a purchase this backend
      // never linked. The policy decides whether to materialize it unclaimed;
      // the owning account can still claim it later through the link endpoint.
      if (outcome === 'no_purchase') {
        const decision = policy.decideMaterialize({
          appCfg,
          action,
          productId: p.productId,
          environment: purchase.environment,
          purchase,
        });
        if (decision.materialize) {
          await assertHeld(tx, held);
          await policy.issue(tx, held, {
            purpose: 'materialize',
            storeId: appCfg.storeId,
            appCfg,
            entitlement: decision.entitlement,
            source: {
              originalTransactionId: purchase.originalTransactionId,
              transactionId: p.transactionId,
              bundleId: appCfg.bundleId,
              environment: purchase.environment,
              productId: p.productId,
              expiresDate: p.expiresDate,
            },
          });
          outcome = await applyStoreKitNotification(tx, applyInput, { restoreActivations });
        }
      }
      // Committed-apply success: resolves earlier apply failures of this operation in THIS transaction.
      await recordStoreKitEventSafe(tx, { storeId: appCfg.storeId, operationId, stage: 'apply', outcome: 'ok' });
      return outcome;
    });
  } catch (e) {
    if (e instanceof LockSetUnstable) return c.json({ error: 'purchase is being updated; retry shortly' }, 503);
    // The apply transaction rolled back (including the claim), so Apple's retry re-enters apply.
    await recordStoreKitEventDetached({
      storeId: appCfg.storeId, operationId, stage: 'apply', outcome: 'failed', error: storeKitErrorText(e),
    });
    throw e;
  }

  return c.json({ received: true }, 200);
});

// ── link a verified App-Store purchase to the signed-in account ─────────────
// Client contract preserved from RightSites (/v1/shop/pro/link-storekit): the
// request carries ONLY the Apple-signed JWS plus this device's own context
// (deviceIdHash / deviceLabel / optional platform hint). Every purchase fact
// — originalTransactionId, bundleId, productId, environment, revocation —
// comes from the verified payload; nothing is trusted from the body.
// Which storekit_app verifies it is chosen by (resolved store, body.appKey)
// → config row, never by request-supplied bundle/environment values.
const LinkStoreKitIn = z.object({
  appKey: z.string().min(1),
  signedTransactionInfo: z.string().min(20),
  deviceIdHash: z.string().min(32).max(128),
  platform: z.enum(['macos', 'windows', 'ios', 'ipados', 'watchos', 'android']).optional(),
  deviceLabel: z.string().max(200).optional(),
});

const LeaseOut = z.object({
  leaseId: z.string().nullable(), deviceIdHash: z.string(), pool: z.string().nullable(),
  entitlement: z.string().nullable(), issuedAt: z.string().nullable(), expiresAt: z.string().nullable(),
  graceSeconds: z.number().int(), generation: z.number().int(), signature: z.string().nullable(),
});

const purchaseOf = (p: StoreKitTransactionPayload, storeId: string): PurchaseId => ({
  storeId, environment: p.environment, originalTransactionId: p.originalTransactionId,
});

storeKitWebhooks.openapi(
  createRoute({
    method: 'post', path: '/v1/shop/pro/link-storekit',
    summary: 'Link a VERIFIED App Store purchase to the signed-in account and activate this device',
    request: {
      body: { content: J(LinkStoreKitIn.loose()) },
    },
    responses: {
      200: { description: 'Linked', content: J(z.object({ ok: z.boolean(), activationToken: z.string(), lease: LeaseOut })) },
      400: { description: 'JWS failed verification, unknown app/product, or rejected environment', ...errBody },
      401: { description: 'Unauthenticated, or purchase already linked to a different account', ...errBody },
      409: { description: 'Device seat limit reached', ...errBody },
      422: { description: 'Purchase was refunded/revoked by Apple', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const st = await resolveStoreFromCtx(c);
    const body = c.req.valid('json');
    installDefaultStoreKitPolicy();
    const policy = storeKitPolicyFor(body.appKey);

    // Engine steps A–C: no transaction is open while Apple is verified.
    const outcome = await linkOutcome(c, st.id, body, policy);
    const res: HttpResult = policy.respond(outcome);
    if (res.status === 200) return c.json(res.body as { ok: boolean; activationToken: string; lease: z.infer<typeof LeaseOut> }, 200);
    throw new HttpError(res.status, res.message);
  }),
);

/** Engine link orchestration (STOREKIT §4.2). Returns the outcome; respond() maps it to HTTP. */
async function linkOutcome(
  c: Parameters<typeof customerToken>[0],
  storeId: string,
  body: z.infer<typeof LinkStoreKitIn> & Record<string, unknown>,
  policy: ReturnType<typeof storeKitPolicyFor>,
): Promise<LinkOutcome> {
  const appCfg: StoreKitAppConfig | null = await withStore(storeId, (tx) => loadStoreKitAppConfig(tx, storeId, body.appKey));
  if (!appCfg) return { kind: 'no_config' };

  // De-fork 2.9: verify and apply stages recorded in storekit_event.
  const operationId = storeKitLinkOperationId(body.appKey, body.signedTransactionInfo);
  const verified = await verifyStoreKitTransactionForDeployment(body.signedTransactionInfo, deploymentConfigFor(appCfg));
  if (verified.kind !== 'ok') {
    // Unauthenticated input: bounded by payload digest and a per-(ip, app) budget.
    const ip = clientIp(c as Parameters<typeof clientIp>[0]);
    await recordStoreKitVerifyFailureBounded(
      { storeId, operationId, error: `verify:${verified.kind}` },
      async () => {
        if ((await storekitVerifyFailureRetryAfter(ip, body.appKey)) > 0) return false;
        await recordStorekitVerifyFailure(ip, body.appKey);
        return true;
      },
    );
    return { kind: 'verify_failed', reason: verified.kind };
  }
  await recordStoreKitEventDetached({ storeId, operationId, stage: 'verify', outcome: 'ok' });

  const custToken = customerToken(c);
  const cust = custToken ? await withStore(storeId, (tx) => resolveCustomer(tx, custToken)) : null;
  if (!cust) return { kind: 'unauth' };

  // Policy-declared request fields (linkRequestExtension), parsed here so a malformed extension is a
  // validation outcome after the customer check, like every other pre-transaction rejection.
  let extensions: Record<string, unknown> = {};
  if (policy.linkRequestExtension) {
    const parsed = z.object(policy.linkRequestExtension).safeParse(body);
    if (!parsed.success) return { kind: 'validation', status: 400, message: 'invalid link request' };
    extensions = parsed.data;
  }

  // Engine step D: policy validation (may verify paired proofs; no DB writes).
  const validation = await policy.validateLink({
    storeId,
    appCfg,
    request: { ...body, extensions },
    primary: verified.payload,
    customerId: cust.id,
    verifyPaired: (jws) => verifyStoreKitTransactionForDeployment(jws, deploymentConfigFor(appCfg)),
  });
  if (!validation.ok) return { kind: 'validation', status: validation.status, message: validation.message };
  const proofs: VerifiedProofSet = validation.proofs;

  // Engine steps E–F: lock the verified purchase identities, then issue under the set.
  const purchases = [purchaseOf(proofs.primary, storeId), ...(proofs.paired ? [purchaseOf(proofs.paired, storeId)] : [])];
  const entitlement = appCfg.productMap[proofs.primary.productId] ?? null;
  let issued;
  try {
    issued = await withLockedSet(storeId, { kind: 'link', purchases }, async (tx, held) => {
      await assertHeld(tx, held);
      const result = await policy.issue(tx, held, {
      purpose: 'link',
      storeId,
      appCfg,
      proofs,
      customerId: cust.id,
      entitlement,
      device: { deviceIdHash: body.deviceIdHash, platform: body.platform ?? null, label: body.deviceLabel ?? null },
      facts: validation.facts,
      });
      // Issued or definitively refused (seat limit, conflict): either concludes the operation.
      await recordStoreKitEventSafe(tx, { storeId, operationId, stage: 'apply', outcome: 'ok' });
      return result;
    });
  } catch (e) {
    if (e instanceof LockSetUnstable) return { kind: 'lock_unstable' };
    await recordStoreKitEventDetached({ storeId, operationId, stage: 'apply', outcome: 'failed', error: storeKitErrorText(e) });
    throw e;
  }
  if (issued.kind === 'ok') {
    return { kind: 'issued', result: issued, deviceIdHash: body.deviceIdHash, deviceLabel: body.deviceLabel ?? null };
  }
  return { kind: 'issue_rejected', result: issued };
}
