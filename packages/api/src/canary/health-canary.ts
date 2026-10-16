/**
 * Health canary emitter (PLAN 7.16, I-8; X-34, X-38). Backs
 * POST /v1/admin/system/canary. Every channel goes through the REAL outbox
 * path: email via the real dispatch templates + enqueueEmail, webhook via
 * the webhook_delivery outbox to one canary endpoint, push via push_outbox.
 * Recipients come only from store.config.health.canary.{email,webhookUrl,
 * pushToken}; nothing is addressed to a customer or to a merchant subscription.
 * Canary rows carry `canary: true` + marker `health.canary` (canary/marker.ts).
 */
import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { withStore, type Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { env } from '../env.js';
import { HttpError } from '../routes/admin-helpers.js';
import { rateLimitBackend } from '../auth/rate-limit-backend.js';
import { assertSafeOutboundUrl, type OutboundUrlLookup } from '../security/outbound-url.js';
import {
  EMAIL_KIND,
  enqueueOrderConfirmation,
  enqueuePasswordReset,
  enqueueShippingNotification,
  enqueueTrialLicenseKey,
  resolveStorefrontUrl,
  type StoreEmailCtx,
} from '../email/dispatch.js';
import { enqueueCanaryPush } from '../push/outbox.js';
import { emitCanaryWebhook } from '../webhooks/emit.js';
import { CANARY_TOPIC } from './marker.js';

export const CANARY_CHANNELS = ['email', 'webhook', 'push'] as const;
export type CanaryChannel = (typeof CANARY_CHANNELS)[number];

/** Email kinds the canary renders. `trial_license_key` is the license-delivery
 *  template (templates.ts trialLicenseKey). */
export const CANARY_EMAIL_KINDS = [
  EMAIL_KIND.ORDER_CONFIRMATION,
  EMAIL_KIND.TRIAL_LICENSE_KEY,
  EMAIL_KIND.SHIPPING_NOTIFICATION,
  EMAIL_KIND.PASSWORD_RESET,
] as const;
export type CanaryEmailKind = (typeof CANARY_EMAIL_KINDS)[number];

const MINUTE_MS = 60_000;
const RATE_BUCKET = 'health-canary';

export interface CanaryRequest {
  slot: number;
  channels: CanaryChannel[];
  kinds?: CanaryEmailKind[];
}

export interface CanaryRow {
  channel: CanaryChannel;
  kind?: CanaryEmailKind;
  id: string;
}

export interface CanaryResult {
  slot: number;
  rows: CanaryRow[];
  skipped: Array<{ channel: CanaryChannel; reason: string }>;
}

export interface CanaryDeps {
  /** DNS lookup for the webhook SSRF guard (tests inject one). */
  lookup?: OutboundUrlLookup;
  /** Override env.JOBS_PUSH_ENABLED (tests). */
  pushEnabled?: boolean;
}

interface CanaryConfig { email?: string; webhookUrl?: string; pushToken?: string; pushEnvironment?: string }

export function readCanaryConfig(config: unknown): CanaryConfig {
  const canary = ((config as { health?: { canary?: unknown } } | null)?.health?.canary ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  return {
    email: str(canary.email),
    webhookUrl: str(canary.webhookUrl),
    pushToken: str(canary.pushToken),
    pushEnvironment: str(canary.pushEnvironment),
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Per-store, per-channel budget: one canary per channel per minute. */
export async function canaryRetryAfter(storeId: string, channels: CanaryChannel[]): Promise<number> {
  let worst = 0;
  for (const ch of channels) {
    const r = await rateLimitBackend().check(RATE_BUCKET, `${storeId}|${ch}`, MINUTE_MS, 1);
    worst = Math.max(worst, r);
  }
  return worst;
}

export async function recordCanaryEmit(storeId: string, channels: CanaryChannel[]): Promise<void> {
  for (const ch of channels) {
    await rateLimitBackend().recordFailure(RATE_BUCKET, `${storeId}|${ch}`, MINUTE_MS);
  }
}

/** Shape-check the request before any DB work. Throws HttpError 422. */
export function validateCanaryRequest(req: CanaryRequest): void {
  if (!Number.isInteger(req.slot) || req.slot < 0) throw new HttpError(422, 'slot must be a non-negative integer', 'canary_slot_invalid', 'slot');
  if (!req.channels.length) throw new HttpError(422, 'at least one channel is required', 'canary_channels_empty', 'channels');
  if (new Set(req.channels).size !== req.channels.length) throw new HttpError(422, 'channels must be unique', 'canary_channels_duplicate', 'channels');
  if (req.kinds && !req.channels.includes('email')) {
    throw new HttpError(422, 'kinds requires the email channel', 'canary_kinds_without_email', 'kinds');
  }
}

/** Fixed fixture data: same bytes every run so the canary is comparable. */
function fixtures(ctx: StoreEmailCtx & { storefrontUrl: string }) {
  return {
    order: { code: 'CANARY-ORDER-0001', grandTotal: 1000, currency: ctx.currency, lines: [{ name: 'Canary fixture item', quantity: 1, lineTotal: 1000 }] },
    shipping: { code: 'CANARY-ORDER-0001', trackingCode: 'CANARY-TRACKING-0001', carrier: 'Canary Carrier' },
    reset: { url: `${ctx.storefrontUrl}/reset-password?token=canary-fixture`, ttlHours: 1 },
    license: { key: 'CANARY-FIXTURE-KEY-0000', days: 14 },
  };
}

/** Emit one canary per requested channel/kind. Runs in one store transaction;
 *  any refusal happens before the first insert, so nothing is half-emitted. */
export async function emitHealthCanary(storeId: string, req: CanaryRequest, deps: CanaryDeps = {}): Promise<CanaryResult> {
  validateCanaryRequest(req);
  const channels = req.channels;
  const kinds = req.kinds?.length ? [...new Set(req.kinds)] : [...CANARY_EMAIL_KINDS];
  const pushEnabled = deps.pushEnabled ?? env.JOBS_PUSH_ENABLED === '1';

  // Read config + store, resolve recipients, and refuse before any insert.
  const [store] = await withStore(storeId, (tx) => tx.select({ name: s.store.name, currency: s.store.currency, config: s.store.config })
    .from(s.store).where(eq(s.store.id, storeId)).limit(1));
  if (!store) throw new HttpError(404, 'store not found', 'store_not_found');
  const cfg = readCanaryConfig(store.config);
  const emailCtxBase: StoreEmailCtx & { storefrontUrl: string } = {
    name: store.name, currency: store.currency, config: store.config, storeId,
    storefrontUrl: resolveStorefrontUrl({ name: store.name, currency: store.currency, config: store.config }),
  };
  const skipped: CanaryResult['skipped'] = [];
  const plan: CanaryChannel[] = [];

  if (channels.includes('email')) {
    if (!cfg.email || !EMAIL_RE.test(cfg.email)) throw new HttpError(422, 'health.canary.email is not configured', 'canary_email_not_configured', 'health.canary.email');
    plan.push('email');
  }
  if (channels.includes('webhook')) {
    if (!cfg.webhookUrl) throw new HttpError(422, 'health.canary.webhookUrl is not configured', 'canary_webhook_not_configured', 'health.canary.webhookUrl');
    try {
      await assertSafeOutboundUrl(cfg.webhookUrl, deps.lookup ? { lookup: deps.lookup } : {});
    } catch (e) {
      throw new HttpError(422, `health.canary.webhookUrl refused: ${e instanceof Error ? e.message : 'unsafe URL'}`, 'canary_webhook_url_unsafe', 'health.canary.webhookUrl');
    }
    plan.push('webhook');
  }
  if (channels.includes('push')) {
    if (!pushEnabled) {
      skipped.push({ channel: 'push', reason: 'push_jobs_disabled' });
    } else {
      if (!cfg.pushToken) throw new HttpError(422, 'health.canary.pushToken is not configured', 'canary_push_not_configured', 'health.canary.pushToken');
      plan.push('push');
    }
  }

  const rows: CanaryRow[] = [];
  const fx = fixtures(emailCtxBase);

  await withStore(storeId, async (tx: Tx) => {
    if (plan.includes('email')) {
      for (const kind of kinds) {
        await enqueueCanaryEmail(tx, storeId, emailCtxBase, cfg.email!, kind, fx);
        const id = await canaryEmailRowId(tx, storeId, cfg.email!, kind);
        rows.push({ channel: 'email', kind, id });
      }
    }
    if (plan.includes('webhook')) {
      const endpointId = await upsertCanaryEndpoint(tx, storeId, cfg.webhookUrl!);
      const id = await emitCanaryWebhook(tx, storeId, endpointId, { slot: req.slot, emittedAt: new Date().toISOString() });
      rows.push({ channel: 'webhook', id });
    }
    if (plan.includes('push')) {
      const id = await enqueueCanaryPush(tx, storeId, {
        deviceToken: cfg.pushToken!,
        environment: cfg.pushEnvironment ?? env.APNS_DEFAULT_ENVIRONMENT,
        payload: { aps: { alert: { title: 'Health canary', body: `slot ${req.slot}` } }, slot: req.slot },
      });
      rows.push({ channel: 'push', id });
    }
  });

  return { slot: req.slot, rows, skipped };
}

async function enqueueCanaryEmail(
  tx: Tx,
  storeId: string,
  ctx: StoreEmailCtx,
  to: string,
  kind: CanaryEmailKind,
  fx: ReturnType<typeof fixtures>,
): Promise<void> {
  switch (kind) {
    case EMAIL_KIND.ORDER_CONFIRMATION:
      await enqueueOrderConfirmation(tx, storeId, ctx, to, fx.order, true);
      return;
    case EMAIL_KIND.SHIPPING_NOTIFICATION:
      await enqueueShippingNotification(tx, storeId, ctx, to, fx.shipping, true);
      return;
    case EMAIL_KIND.PASSWORD_RESET:
      await enqueuePasswordReset(tx, storeId, ctx, to, fx.reset, true);
      return;
    case EMAIL_KIND.TRIAL_LICENSE_KEY:
      await enqueueTrialLicenseKey(tx, storeId, ctx, to, fx.license, true);
      return;
  }
}

/** Id of the canary email row this transaction just inserted for (recipient, kind).
 *  `created_at` defaults to the transaction start, so only this txn's rows match. */
async function canaryEmailRowId(tx: Tx, storeId: string, to: string, kind: string): Promise<string> {
  const r = await tx.execute(sql`SELECT id FROM email_outbox
    WHERE store_id = ${storeId} AND kind = ${kind} AND recipient = ${to}
      AND payload->>'canary' = 'true' AND created_at = now()
    ORDER BY created_at DESC LIMIT 1`);
  const row = (r.rows as Array<{ id: string }>)[0];
  if (!row) throw new Error(`canary email row not found for kind ${kind}`);
  return row.id;
}

/** The one canary endpoint for this store: subscribed to health.canary only,
 *  created here (merchants cannot subscribe to the reserved topic). */
async function upsertCanaryEndpoint(tx: Tx, storeId: string, url: string): Promise<string> {
  const [existing] = await tx.select({ id: s.webhookEndpoint.id, enabled: s.webhookEndpoint.enabled })
    .from(s.webhookEndpoint)
    .where(and(eq(s.webhookEndpoint.storeId, storeId), eq(s.webhookEndpoint.url, url), sql`${s.webhookEndpoint.topics} @> ARRAY[${CANARY_TOPIC}]::text[]`))
    .limit(1);
  if (existing) {
    if (!existing.enabled) await tx.update(s.webhookEndpoint).set({ enabled: true }).where(eq(s.webhookEndpoint.id, existing.id));
    return existing.id;
  }
  const [row] = await tx.insert(s.webhookEndpoint).values({
    storeId, url, topics: [CANARY_TOPIC], secret: randomBytes(24).toString('hex'),
  }).returning({ id: s.webhookEndpoint.id });
  return row!.id;
}
