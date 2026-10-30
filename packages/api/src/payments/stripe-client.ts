import Stripe from 'stripe';

/**
 * The Stripe API version every outbound request from this API uses. Defined once; every `new Stripe(` in production code
 * goes through `newStripeClient`, so the SDK's own default can never change request behaviour on a dependency bump.
 *
 * '2026-08-26.dahlia' is the version the previously deployed SDK (stripe 22.6.2) defaulted to, so moving to SDK 23
 * (default '2026-09-30.endive') does not change what Stripe returns for our requests. Changing this value is a payments
 * decision: qualify the new version against the webhook payload version in Stripe test mode first (payment success and
 * failure, refunds, disputes, duplicate and delayed delivery) and update this comment with the decision.
 *
 * This pins REQUEST/response behaviour only. Inbound webhook payloads keep the version of the webhook endpoint (and,
 * for endpoints without one, the account default), which this release deliberately leaves unchanged.
 */
export const STRIPE_API_VERSION = '2026-08-26.dahlia';

// SDK 23's `apiVersion` type is its own latest literal and rejects an older one, so widen to string first and narrow to
// the SDK's declared type. This is the only cast; it changes no runtime value.
type SdkApiVersion = NonNullable<NonNullable<ConstructorParameters<typeof Stripe>[1]>['apiVersion']>;

/**
 * A7/C1 explicit gateway deadlines (the SDK default is an 80s per-attempt timeout with 2 network retries, ~250s worst
 * case). Per attempt: 20s. One network retry: the SDK resends a POST with the same Idempotency-Key (ours when given,
 * else its own), so a retry after a lost response returns the original object instead of a second effect. Total
 * worst case = attempts x timeout + SDK max backoff (5s) per retry. A timeout surfaces as an error whose provider
 * outcome is unknown; callers already treat that as Pending/unknown and reconcile (refunds: stripe.ts refundPayment;
 * intents: client-side confirmation + webhook), never as a definite failure that permits a fresh charge.
 */
export const STRIPE_REQUEST_TIMEOUT_MS = 20_000;
export const STRIPE_MAX_NETWORK_RETRIES = 1;
const STRIPE_SDK_MAX_RETRY_DELAY_MS = 5_000;
export const STRIPE_TOTAL_DEADLINE_MS = (STRIPE_MAX_NETWORK_RETRIES + 1) * STRIPE_REQUEST_TIMEOUT_MS + STRIPE_MAX_NETWORK_RETRIES * STRIPE_SDK_MAX_RETRY_DELAY_MS;

export function newStripeClient(secretKey: string): Stripe {
  return new Stripe(secretKey, {
    apiVersion: STRIPE_API_VERSION as string as SdkApiVersion,
    timeout: STRIPE_REQUEST_TIMEOUT_MS,
    maxNetworkRetries: STRIPE_MAX_NETWORK_RETRIES,
  });
}
