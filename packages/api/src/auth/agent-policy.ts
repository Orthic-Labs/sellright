/**
 * Hard block for admin users of kind 'agent' (docs/plans/2026-10-10-agent-role-v5.md, D1).
 * Keys are exact registered routes as Hono matches them ('METHOD /v1/admin/...' with ':param' segments).
 * Anything NOT here falls through to the ordinary role/permission guards, which treat an agent like
 * the human role it holds. This set wins over any permission grant (D7).
 *
 * Owner's rule: reversible is allowed, irreversible needs a human. "Disable a product" is fine;
 * "delete a product" is not. scripts/assert-agent-boundary.mjs proves every registered DELETE route and
 * every route whose path names an irreversible verb is in this set, so new routes cannot slip past it.
 */
export type DenyGroup = 'delete' | 'irreversible_order' | 'money_out' | 'settlement' | 'credit' | 'entitlement' | 'release' | 'identity' | 'credentials' | 'system';

const D = (group: DenyGroup, ...keys: string[]): [string, DenyGroup][] => keys.map((k) => [k, group]);

export const AGENT_DENIED: ReadonlyMap<string, DenyGroup> = new Map<string, DenyGroup>([
  // every hard delete (the inventory script asserts this list == all registered DELETE /v1/admin routes)
  ...D('delete',
    'DELETE /v1/admin/assets/:id', 'DELETE /v1/admin/blog/:id', 'DELETE /v1/admin/collections/:id', 'DELETE /v1/admin/collections/:id/products/:productId',
    'DELETE /v1/admin/devices/:token', 'DELETE /v1/admin/discounts/:id', 'DELETE /v1/admin/products/:id', 'DELETE /v1/admin/products/:id/assets/:assetId',
    'DELETE /v1/admin/promotions/:id', 'DELETE /v1/admin/reviews/:id', 'DELETE /v1/admin/shipping-methods/:id', 'DELETE /v1/admin/staff/:adminUserId',
    'DELETE /v1/admin/tax-zones/:id', 'DELETE /v1/admin/variants/:id', 'DELETE /v1/admin/webhooks/:id', 'DELETE /v1/admin/agents/:adminUserId'),
  // orders: cancel + purge are terminal; trash/restore (bulk-soft-delete / bulk-restore) are reversible and allowed
  ...D('irreversible_order', 'POST /v1/admin/orders/:code/cancel', 'POST /v1/admin/orders/bulk-cancel', 'POST /v1/admin/orders/bulk-purge'),
  // money leaving the store
  ...D('money_out', 'POST /v1/admin/orders/:code/refund', 'POST /v1/admin/orders/:code/edit/:editId/refund', 'POST /v1/admin/affiliates/:id/settle',
    'POST /v1/admin/returns/:id/approve'), // approval reserves + requests the refund (admin-orders.ts) — D11; reject stays allowed
  // settlement reconciliation: re-drives money and entitlement effects (effects/events retry, stripe-reconcile, verify)
  ...D('settlement', 'POST /v1/admin/payment-reconciliation/:id/verify', 'POST /v1/admin/payment-reconciliation/effects/:id/retry',
    'POST /v1/admin/payment-reconciliation/events/:id/retry', 'POST /v1/admin/payment-reconciliation/orders/:code/stripe-reconcile'),
  // credit out of thin air (D12): loyalty points are redeemable at checkout; gift cards are handled as a mixed route (created disabled)
  ...D('credit', 'POST /v1/admin/customers/:id/loyalty/adjust', 'POST /v1/admin/loyalty/ledger/:id/reverse'),
  // entitlements: issue/revoke licences, release held reservations, revoke/clear verifications
  ...D('entitlement', 'POST /v1/admin/licenses', 'POST /v1/admin/payment-reconciliation/reservations/:id/override-release',
    'POST /v1/admin/payment-reconciliation/effects/:id/approve-issuance', // a human approves an issuance an agent edit (or an unresolved actor) was held from
    'POST /v1/admin/sheerid/revoke', 'POST /v1/admin/customers/:id/verification/clear'),
  // publishing a software release to customers
  ...D('release', 'POST /v1/admin/apps/releases'),
  // identities: staff and agents are managed by humans only
  ...D('identity', 'POST /v1/admin/staff', 'POST /v1/admin/staff/invites', 'POST /v1/admin/staff/accept', 'PATCH /v1/admin/staff/:adminUserId',
    'PUT /v1/admin/staff/:adminUserId/permissions', 'POST /v1/admin/staff/:adminUserId/revoke-sessions', 'POST /v1/admin/agents', 'POST /v1/admin/agents/:adminUserId/rotate'),
  // credentials: 2FA, step-up, payment + e-mail secrets (test-send is allowed: it only sends)
  ...D('credentials', 'POST /v1/admin/2fa/setup', 'POST /v1/admin/2fa/enable', 'POST /v1/admin/2fa/disable', 'POST /v1/admin/step-up',
    'PUT /v1/admin/payments/settings/:provider/:mode', 'POST /v1/admin/payments/settings/:provider/:mode/verify', 'POST /v1/admin/payments/settings/stripe/:mode/webhook', 'PUT /v1/admin/email/settings',
    // secrets hiding in settings routes (Astra v5 F3): SheerID client/webhook secrets, Listmonk API token, preview-token rotation, Google OAuth client id, Stripe live/test switch
    'PATCH /v1/admin/sheerid/config', 'PATCH /v1/admin/marketing/config', 'POST /v1/admin/settings/preview-token', 'PATCH /v1/admin/settings/google', 'PATCH /v1/admin/settings/payments/stripe-mode'),
  // installation / system operations
  ...D('system', 'PATCH /v1/admin/system/checklist/offsite-backup-confirmed', 'POST /v1/admin/system/canary'),
]);

/** Routes the invariant regex would flag but that are deliberately allowed. Keep this list short and justified. */
export const AGENT_DENY_EXCEPTIONS: ReadonlySet<string> = new Set([
  'POST /v1/admin/agents/browser-session', // the agent's own token→cookie exchange
  'POST /v1/admin/email/settings/test-send', // sends one e-mail; changes nothing
  'POST /v1/admin/cache/purge', // CDN cache purge: harmless, re-fills on the next request
  'POST /v1/admin/reviews/:id/approve', // review approval: reversible (reject later); the loyalty bonus is additive
  'POST /v1/admin/variants/:id/stock/adjust', // stock delta with a reason: ordinary inventory work, reversible
]);

/** Path fragments that mark a mutation as irreversible / money / entitlement / identity / credential / system.
 *  Delimiter is `/` OR `-` so `bulk-cancel`, `bulk-purge`, `stripe-mode`, `preview-token` are caught. Used by scripts/assert-agent-boundary.mjs. */
export const IRREVERSIBLE_PATH = /[/-](cancel|purge|refund|revoke|settle|releases|licenses|staff|agents|2fa|step-up|override-release|approve|retry|reconcile|verify|secret|token|mode|google|adjust|reverse)(\/|$)|\/payments\/settings|\/email\/settings|\/system\/|\/payment-reconciliation\/|\/sheerid\/config|\/marketing\/config|verification\/clear/;

export function agentDenied(method: string, matchedRoutePath: string): DenyGroup | null {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return null;
  return AGENT_DENIED.get(`${m} ${matchedRoutePath}`) ?? null;
}
