# Plan: One-Click Install and Guided Setup (v2)

**Status:** Approved for implementation (owner, 2026-09-27). v2 incorporates the independent review of v1 (commit `5c1fb9c`).
**Scope:** How a new SellRight owner goes from nothing to a working store, and how the installation is updated and recovered.

## 1. Decisions

1. **One product with adapters for each deployment target.** What's shared:
   - application images;
   - the settings format;
   - onboarding;
   - the backup/recovery format.

   **Each deployment target has its own adapter**, which owns TLS, storage and updates. The first and only supported adapter is a **single VPS** (Docker Compose plus an installer). PaaS and marketplace adapters come later and must each prove their own storage, TLS and update behaviour.
2. **The owner sets exactly one credential**, their own email and password, in the browser. Every machine secret is generated and never shown. The admin password is **never** the same as any database password or key.
3. **Two kinds of authority:**
   - **Installation administrator:** a new install-wide flag on `admin_user`. It owns system operations: updates, backups, restore, recovery kit, adding stores.
   - **Store owner / manager / staff:** unchanged; attached to a store membership (`admin_user_store`).

   The person who claims the install becomes both. Owning store B never grants system operations over store A.
4. **Claiming is one operation; onboarding is ordinary authenticated work:**
   - **The claim:** a single-use claim token, 128-bit random and stored hashed, is redeemed by `POST /v1/setup/claim` (email, password, name). That call creates the installation administrator, the first store and its owner membership in one transaction, then invalidates the token.
   - **Concurrent claims:** a second claim loses on a row lock or unique constraint.
   - **Expiry:** tokens expire 7 days after issue.
   - **Recovery:** `sellright setup-link` issues a new token only while no installation administrator exists. `sellright reset-admin` covers lockout afterwards.
   - **After claiming:** every `/v1/setup/*` route returns 404. Onboarding continues in the normal logged-in admin.
5. **Three setup screens, then a checklist:**
   1. Claim and create your account; system checks run automatically.
   2. Name your store and confirm country, currency and timezone (defaults come from the country).
   3. Open a **working private storefront preview**.

   Everything else is a persistent **setup checklist**; each item opens its settings page:
   - products;
   - domain;
   - payments;
   - email;
   - shipping and tax;
   - recovery kit and off-site backup.

   **Publish store** is an explicit action with readiness checks: at least one live payment method, a working email transport, a domain with a valid certificate, and a downloaded recovery kit. Until then the storefront is private (preview-token only), and demonstration orders are flagged and excluded from reports.
6. **Settings live in the database; secrets are encrypted:**
   - **What stays in environment variables:** infrastructure only (database URLs, `SELLRIGHT_MASTER_KEY`, ports).
   - **What moves to the database:** everything owner-editable, per store.
   - **How secrets are stored:** secret fields are encrypted with AES-256-GCM under a key derived from the master key, with a key version for rotation. The admin only ever shows the last 4 characters.
   - **Existing deployments:** if an environment value is set it wins, and the admin shows it as "managed by server configuration".
7. **Payment settings (applies whether or not the one-click install is used).** For each method, test and live credentials are separate sets, and switching mode never copies one into the other:

   | Provider | Owner enters | SellRight does |
   |---|---|---|
   | Stripe | Publishable key and secret (or restricted) key, per mode | Checks the key; creates the webhook endpoint through the Stripe API and stores the returned signing secret encrypted. Re-running is idempotent (finds its own endpoint by URL and metadata; replaces it if the secret was lost). A manual webhook-secret field remains as a fallback |
   | NMI | Security key, tokenization key; test-mode flag | Checks the key with a harmless query |
   | Sezzle | Public key, private key; sandbox/production | Checks by requesting an auth token |

   Every provider gets a "Test connection" button. A Stripe App (predefined restricted key) is deferred.
8. **HTTPS before a domain:** a Let's Encrypt IP-address certificate (160-hour lifetime, generally available since 2026-01-15), issued and renewed by Caddy. A spike must confirm this on the pinned Caddy version; if it fails, the installer requires a domain up front. The Domain checklist item shows the DNS record, checks it live, issues the certificate and redirects.
9. **The storefront reads its settings at runtime, per store.** Today's storefront bakes its settings in at build time (`VITE_*`). It will instead fetch store identity, theme, URLs and payment public keys from the API when a request comes in, for the host being requested. That gives one generic image for every store. Build-time variables remain only as development fallbacks. This is a prerequisite for including the storefront in the install.
10. **Recovery covers total server loss:**
    - **What a backup set contains:**
      - the database;
      - assets;
      - downloads;
      - a manifest recording the application version and image digests, plus a checksum.
    - **The recovery kit:** a file generated at install time and downloaded by the installation administrator. It holds the master key and backup location details. It's required for Publish, and its loss is warned about.
    - **Encryption:** off-site backups (any S3-compatible bucket) are encrypted with a key derived from the recovery kit.
    - **Restore to a new server:** `sellright restore --kit <file>`.
    - **Restore drills** run in an isolated database with email, payments, webhooks and jobs forced off, and must never touch live data.
11. **Updates promise only what they can deliver:**
    - **Migration policy (expand/contract):** each release's migrations must be backward compatible with the previous release's code. Destructive changes wait until a later release.
    - **The update sequence:**
      1. Enter maintenance mode: the storefront shows "back soon", the API rejects writes, workers stop.
      2. Take a backup.
      3. Pull the signed images.
      4. Migrate.
      5. Start.
      6. Run **functional checks**: the database, a catalog read, a cart-and-checkout dry run in an isolated test store, and the queue.
      7. Leave maintenance.
    - **Automatic rollback:** it happens only when a check fails **before the store reopens**. It restarts the previous images. That's safe because migrations are backward compatible, and **no backup restore happens**. A failure after reopening is reported, not rolled back automatically.
    - **Who can update:** only installation administrators, through a host-side service (no Docker socket inside any container).

## 2. What exists today (verified)

| Area | Today |
|---|---|
| Install | Hand-fill 8 values in `deploy/.env`, then `docker compose … up -d --build` (builds on the customer's server) |
| First run | `db-init` creates the app role; the API migrates and bootstraps as the owner role, then serves as the app role |
| Storefront | Not in Compose; settings baked in at build time |
| Roles | Per-store membership only (`admin_user_store.role`); no installation-level role |
| Readiness | `/v1/readyz` checks database connectivity only |
| Payment keys | Environment variables; Stripe needs publishable + secret (+ webhook secret) per mode |
| Backups | Manual runbook; no key escrow |

## 3. Workstreams

| WS | Deliverable | Depends on |
|---|---|---|
| **A. Encrypted settings + payment/email settings** | Master-key encryption module; per-store settings storage; Stripe/NMI/Sezzle/SMTP pages with test buttons; Stripe webhook auto-creation; environment-override precedence | — |
| **B. Claim, installation admin, onboarding** | `is_installation_admin`; claim token + `/v1/setup/claim`; 3-screen setup; checklist; Publish readiness gate; private preview token; demo-order flag | A (checklist reads settings status) |
| **C. Runtime storefront configuration** | Storefront settings fetched per store at request time; one generic image; preview-token gate | — |
| **D. Single-VPS appliance + recovery** | Signed prebuilt images (GHCR, cosign); Compose using images and including the storefront; `install.sh`; `sellright` host command (status, logs, setup-link, reset-admin, backup, restore, recovery-kit); backup sets with manifest; restore drill with outbound traffic forced off; Caddy IP-certificate spike | C for the storefront service |
| **E. Updates** | Maintenance mode; functional checks; host update service; previous-image rollback before reopening; expand/contract policy in `docs/runbooks/migrations.md` | D |
| **F. Other deployment adapters** | Later; each proves storage/TLS/updates | E |

## 4. Acceptance (single VPS)

1. **Fresh install:** a fresh Ubuntu server reaches a private storefront preview using one pasted line and a browser, typing no secret other than the owner's password.
2. **Claiming:** two concurrent claims produce exactly one installation administrator, and every `/v1/setup/*` route returns 404 afterwards.
3. **Recovery:** with the recovery kit plus an off-site backup, a brand-new server restores the database, assets, downloads and decryptable payment settings. The restore drill sends no email and makes no payment call.
4. **Updates:** an update whose functional check fails rolls back to the previous images before reopening, with no data loss.
5. **Stripe:** entering pk+sk for test mode creates a webhook automatically; a test checkout succeeds; live keys are entered separately.

## 5. Open questions

1. **Licensing:** is there a licence step for paid tiers?
2. **Free subdomains:** should Orthic Labs run a free `<store>.sellright.app` service?
3. **Minimum server size:** to be benchmarked, including updates and restores.
4. **Hetzner marketplace:** no public vendor route is verified; ordinary Hetzner VPS installs are supported.

## Sources

- [Let's Encrypt: IP certificates GA](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability)
- [Stripe: create webhook endpoint](https://docs.stripe.com/api/webhook_endpoints/create)
- [Stripe: API keys and modes](https://docs.stripe.com/keys#sandbox-versus-live-mode)
- [Stripe Apps authentication](https://docs.stripe.com/stripe-apps/api-authentication)
- [Render disk limitations](https://render.com/docs/disks#disk-limitations-and-considerations)
- [Railway pre-deploy command](https://docs.railway.com/deployments/pre-deploy-command)
- [Coolify installation (first-visitor admin warning)](https://coolify.io/docs/get-started/installation)
- [Portainer setup timeout](https://docs.portainer.io/faqs/installing/your-portainer-instance-has-timed-out-for-security-purposes-error-fix)
