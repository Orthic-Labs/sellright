# Agent access (automation seats)

An **agent** is an admin identity for scripts and AI operators. It has no password, 2FA or e-mail; it authenticates with an API token. It holds an ordinary role (staff, manager or read-only — never owner) and the same per-action grants as any staff member. The one agent-specific rule: **reversible is allowed, irreversible needs a human.** Disabling a product is fine; deleting it is not.

## Create
- Admin → Staff → **Agent access** → name + role → **Create agent**. The `sra_…` token is shown once. Change its role and grants in the staff list like anyone else.
- Server (owner connection): `node dist/scripts/agent-token.js <store-slug> "<name>" [staff|manager|read_only]` prints the token to stdout; re-running rotates it.

## Use from a script
`curl -H "authorization: Bearer $SRA_TOKEN" -H "x-store-slug: <slug>" https://<store>/v1/admin/orders` — bearer requests are CSRF-exempt; `GET /v1/admin/me` reports `kind: "agent"` and the real role.

## Use from a headless browser
1. Open `https://<store>/admin/login`.
2. From the page: `fetch('/v1/admin/agents/browser-session', { method: 'POST', headers: { authorization: 'Bearer ' + token } })` — sets `sr_admin`/`sr_csrf`. The session lasts ≤12 h, is bound to the token (rotation/revocation ends it), and only one browser session per token is live.
3. Reload; the admin SPA runs as the agent.

## Behind Cloudflare Access
Create a **service token** (Zero Trust → Access → Service Auth) and send `CF-Access-Client-Id` / `CF-Access-Client-Secret` on every request. Revoking it cuts the agent off at the edge.

## What an agent can never do (403, audited, whatever its role or grants)
- **Delete** anything (products, variants, collections, assets, posts, reviews, discounts, promotions, shipping methods, tax zones, webhooks, devices, staff, agents). Disable, unpublish or trash instead.
- **Cancel or purge** orders. Trash and restore are fine.
- **Move money out**: refunds, order-edit refunds (including `settlement: refund_now` on an otherwise ordinary edit), return approval (it reserves a refund — rejecting a return is fine), affiliate payouts.
- **Re-drive settlement**: payment-reconciliation verify / retry / reconcile.
- **Record a manual payment** on an order edit (`settlement: record_payment`): same rule as below, an agent never asserts that money arrived.
- **Turn a draft into a paid order** (`markPaid`): that is a fulfilment request and, for licensed products, a licence. The agent prepares; a human approves. A customer paying through the storefront moves it automatically.
- **Issue credit**: adjust or reverse loyalty points; enable a gift card or change its balance. An agent may *create* a gift card, but it starts disabled until a human enables it.
- **Entitlements**: issue or revoke licences, release held reservations, revoke or clear verifications.
- **Publish** a software release.
- **Manage identities**: create, invite, re-role, grant, force-logout or remove staff or agents.
- **Credentials**: 2FA, step-up, payment or e-mail secrets, SheerID or Listmonk secrets, preview-token rotation, Google OAuth client, Stripe live/test switch.
- **System** operations.
The exact list is `packages/api/src/auth/agent-policy.ts`; CI (`assert:agent-boundary`) proves every `DELETE` route and every irreversible-looking route is in it.

## Everything else follows the role
Create and edit products, variants, prices, stock, collections, tags, posts, assets; prepare draft orders (unpaid — marking one paid is the owner's click); fulfil paid orders; add notes; approve, reject or reply to reviews; export orders and customers; discounts, gift cards, loyalty and webhooks if granted; store settings if manager.

## Guarantees
- Denials are audited before any handler runs. Every allowed mutation is attributed to the agent by an audit row written *before* the handler runs (its HTTP status is filled in afterwards), in addition to whatever entity audit the handler itself writes.
- Billing addresses are not shown to agents on order detail.
- Revocation applies to the next request; a request already authenticated when a rotation commits completes.
- Agents are immutable identities: never given a password, invited, or made owner.
