/**
 * WS-A (one-click install plan §1.7): auto-create the Stripe webhook endpoint
 * for a store+mode when the owner enters live/test API keys, and store the
 * signing secret Stripe returns (encrypted, by the caller). Idempotent:
 * re-running finds ITS OWN endpoint by url+metadata rather than creating a
 * duplicate; if the secret was lost (e.g. a restore from a backup taken
 * before the secret was persisted), it deletes and recreates to get a fresh
 * one — Stripe never re-reveals a signing secret after creation.
 *
 * Injected `StripeWebhookClient` decouples this from the real `stripe` SDK
 * type so unit tests can mock Stripe's HTTP behavior without a live key or
 * network access.
 */

export const MANAGED_BY_KEY = 'sellright_managed';

export function webhookMetadataValue(storeId: string, mode: string): string {
  return `${storeId}:${mode}`;
}

export interface StripeWebhookEndpoint {
  id: string;
  url: string;
  metadata?: Record<string, string> | null;
  secret?: string; // only ever present on the CREATE response
}

export interface StripeWebhookClient {
  webhookEndpoints: {
    list(params: { limit: number }): Promise<{ data: StripeWebhookEndpoint[] }>;
    create(params: { url: string; enabled_events: string[]; metadata: Record<string, string> }): Promise<StripeWebhookEndpoint>;
    del(id: string): Promise<unknown>;
  };
}

export const DEFAULT_STRIPE_EVENTS = [
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'charge.refunded',
  'charge.dispute.created',
];

export interface EnsureWebhookInput {
  storeId: string;
  mode: 'test' | 'live';
  /** Public webhook receiver URL for this store, e.g. `${STOREFRONT_API}/v1/webhooks/stripe`. */
  url: string;
  /** True when we already hold a decryptable signing secret for this endpoint id in the DB.
   *  Passing false forces recreation even if a matching endpoint is found (secret was lost). */
  hasStoredSecret: (endpointId: string) => boolean;
  events?: string[];
}

export interface EnsureWebhookResult {
  endpointId: string;
  /** Present only when a NEW secret was minted (create, or recreate-after-loss)
   *  — the caller must encrypt and persist it immediately; Stripe will not
   *  return it again. */
  newSecret?: string;
  created: boolean;
  recreated: boolean;
}

export async function ensureStripeWebhook(client: StripeWebhookClient, input: EnsureWebhookInput): Promise<EnsureWebhookResult> {
  const marker = webhookMetadataValue(input.storeId, input.mode);
  const { data } = await client.webhookEndpoints.list({ limit: 100 });
  const existing = data.find((e) => e.url === input.url && e.metadata?.[MANAGED_BY_KEY] === marker);

  if (existing && input.hasStoredSecret(existing.id)) {
    return { endpointId: existing.id, created: false, recreated: false };
  }

  if (existing) {
    // Secret was lost (or never persisted) — Stripe cannot re-reveal it, so
    // recreate the endpoint to mint a fresh one.
    await client.webhookEndpoints.del(existing.id);
  }

  const created = await client.webhookEndpoints.create({
    url: input.url,
    enabled_events: input.events ?? DEFAULT_STRIPE_EVENTS,
    metadata: { [MANAGED_BY_KEY]: marker },
  });
  if (!created.secret) throw new Error('Stripe did not return a webhook signing secret on create');
  return { endpointId: created.id, newSecret: created.secret, created: !existing, recreated: !!existing };
}
