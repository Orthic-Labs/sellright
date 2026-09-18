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
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { customerToken, resolveCustomer } from '../auth/session.js';
import { errBody, guard, HttpError, J } from './admin-helpers.js';
import { resolveStoreFromCtx } from './store-context.js';
import { applyStoreKitNotification, ensureStoreKitLicense, issueStoreKitActivation } from '../licensing/storekit-license.js';
import { storeKitNotificationAction } from '../licensing/storekit-notifications.js';
import { verifyStoreKitNotificationForDeployment, verifyStoreKitTransactionForDeployment } from '../licensing/storekit-verify.js';
import {
  deploymentConfigFor,
  loadStoreKitAppByBundleId,
  loadStoreKitAppConfig,
  resolveStoreIdForStoreKitBundle,
  type StoreKitAppConfig,
} from '../licensing/storekit-config.js';

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

  const verified = await verifyStoreKitNotificationForDeployment(signedPayload, deploymentConfigFor(appCfg));
  if (verified.kind === 'retryable') return c.json({ error: 'notification verification temporarily unavailable' }, 503);
  if (verified.kind !== 'ok') return c.json({ error: 'notification verification failed' }, 400);

  await withStore(appCfg.storeId, async (tx) => {
    // Idempotency: claim the notificationUUID — Apple retries non-2xx, and a
    // duplicate delivery must be a no-op.
    const eventId = `apple-storekit:${verified.payload.notificationUUID}`;
    const claimed = await tx.insert(s.processedEvent).values({
      id: eventId,
      storeId: appCfg.storeId,
      type: `apple.storekit.${verified.payload.notificationType}`,
    }).onConflictDoNothing().returning({ id: s.processedEvent.id });
    if (claimed.length === 0) return;

    const action = storeKitNotificationAction(verified.payload.notificationType);
    if (action === 'ignore' || !verified.payload.originalTransactionId || !verified.matchedEnvironment) return;

    const applyInput = {
      storeId: appCfg.storeId,
      action,
      environment: String(verified.matchedEnvironment),
      originalTransactionId: verified.payload.originalTransactionId,
      transactionId: verified.payload.transactionId,
      notificationType: verified.payload.notificationType,
      notificationUUID: verified.payload.notificationUUID,
      expiresDate: verified.payload.expiresDate,
      revocationDate: verified.payload.revocationDate,
    };
    let outcome = await applyStoreKitNotification(tx, applyInput);

    // A renewal/restore can legitimately reference a purchase this backend
    // never linked (it predates the link flow, or the app never posted it).
    // Materialize the license unclaimed — the owning account can still claim
    // it later through the link endpoint's conditional customer update.
    if (outcome === 'no_purchase' && (action === 'renew' || action === 'restore')) {
      const entitlement = verified.payload.productId ? appCfg.productMap[verified.payload.productId] ?? null : null;
      await ensureStoreKitLicense(tx, {
        storeId: appCfg.storeId,
        storekitAppId: appCfg.id,
        appKey: appCfg.appKey,
        source: {
          originalTransactionId: verified.payload.originalTransactionId,
          transactionId: verified.payload.transactionId,
          bundleId: appCfg.bundleId,
          environment: String(verified.matchedEnvironment),
          productId: verified.payload.productId,
          expiresDate: verified.payload.expiresDate,
        },
        entitlement,
      });
      outcome = await applyStoreKitNotification(tx, applyInput);
    }
    return outcome;
  });

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

storeKitWebhooks.openapi(
  createRoute({
    method: 'post', path: '/v1/shop/pro/link-storekit',
    summary: 'Link a VERIFIED App Store purchase to the signed-in account and activate this device',
    request: {
      body: { content: J(LinkStoreKitIn) },
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

    const out = await withStore(st.id, async (tx) => {
      const appCfg: StoreKitAppConfig | null = await loadStoreKitAppConfig(tx, st.id, body.appKey);
      if (!appCfg) return { kind: 'no_config' as const };

      const verified = await verifyStoreKitTransactionForDeployment(body.signedTransactionInfo, deploymentConfigFor(appCfg));
      // Keep the failure reason as data on ONE union member so the outer
      // narrowing on `out.kind` actually collapses to 'activated'.
      if (verified.kind !== 'ok') return { kind: 'verify_failed' as const, reason: verified.kind };

      const custToken = customerToken(c);
      const cust = custToken ? await resolveCustomer(tx, custToken) : null;
      if (!cust) return { kind: 'unauth' as const };

      const entitlement = appCfg.productMap[verified.payload.productId] ?? null;
      const ensured = await ensureStoreKitLicense(tx, {
        storeId: st.id,
        storekitAppId: appCfg.id,
        appKey: body.appKey,
        customerId: cust.id,
        entitlement,
        source: {
          originalTransactionId: verified.payload.originalTransactionId,
          transactionId: verified.payload.transactionId,
          bundleId: verified.payload.bundleId,
          environment: verified.payload.environment,
          productId: verified.payload.productId,
          purchaseDate: verified.payload.purchaseDate,
          expiresDate: verified.payload.expiresDate,
        },
      });
      if (ensured.kind === 'account_conflict') return { kind: 'unauth' as const };

      const activated = await issueStoreKitActivation(tx, {
        storeId: st.id,
        appKey: body.appKey,
        licenseKey: ensured.licenseKey,
        deviceIdHash: body.deviceIdHash,
        deviceLabel: body.deviceLabel ?? null,
      });
      return { kind: 'activated' as const, activated, entitlement };
    });

    if (out.kind === 'no_config') throw new HttpError(400, 'StoreKit purchases are not configured for this app');
    if (out.kind === 'verify_failed') {
      const r = out.reason;
      if (r === 'malformed' || r === 'bad_signature') {
        throw new HttpError(400, 'the App Store transaction could not be verified');
      }
      if (r === 'wrong_bundle' || r === 'wrong_product') {
        throw new HttpError(400, 'this transaction was not issued for this app');
      }
      if (r === 'wrong_environment') {
        throw new HttpError(400, 'unexpected App Store environment');
      }
      throw new HttpError(422, 'this purchase was refunded or revoked by Apple');
    }
    if (out.kind === 'unauth') {
      throw new HttpError(401, 'not authenticated, or purchase already linked to a different account');
    }
    if (out.activated.kind === 'notfound') throw new HttpError(400, 'license could not be activated');
    if (out.activated.kind === 'full') throw new HttpError(409, 'device seat limit reached');

    // Lease-shaped response kept wire-compatible with the RightSites surface
    // the iOS apps already parse: SellRight's activation IS the device
    // credential, so lease fields map from the activation + license.
    const lease = {
      leaseId: out.activated.activationId ?? null,
      deviceIdHash: out.activated.deviceIdHash,
      pool: 'mobile' as const,
      entitlement: out.entitlement?.tier ?? null,
      issuedAt: out.activated.activatedAt ? new Date(out.activated.activatedAt).toISOString() : null,
      expiresAt: out.activated.lic.expiresAt?.toISOString() ?? null,
      graceSeconds: 0,
      generation: 0,
      signature: null,
    };
    return c.json({ ok: true, activationToken: out.activated.activationToken, lease }, 200);
  }),
);
