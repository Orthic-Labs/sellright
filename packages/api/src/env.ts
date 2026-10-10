import { z } from 'zod';
import { productionEnvErrors, resolveFileBackedEnv } from './env-runtime.js';
import { assertAllowedSenders, parseSenderDomainList } from './email/sender-policy.js';

const emptyToUndefined = (value: unknown) => (
  typeof value === 'string' && value.trim() === '' ? undefined : value
);
const optionalEnvString = z.preprocess(emptyToUndefined, z.string().optional());
const optionalEnvEmail = z.preprocess(emptyToUndefined, z.string().email().optional());

/** Fail-fast env validation. The server refuses to boot on missing/invalid config. */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3300),
  // Default targets the :5433 DEV cluster, never :5432 (the prod vendure-postgres
  // Docker port) — an accidental boot without DATABASE_URL set must not reach prod.
  // The cp:cp creds don't auth anyway; this is fail-safe-by-port, not by secret.
  DATABASE_URL: z.string().url().default('postgres://cp:cp@127.0.0.1:5433/sellright_dev'),
  /**
   * Non-owner connection string for the app role (NOSUPERUSER NOBYPASSRLS).
   * Used by the RLS test suite to exercise tenant isolation under FORCE RLS.
   * Falls back to DATABASE_URL when not set (e.g. local dev where only one role exists).
   */
  DATABASE_URL_NONOWNER: z.string().url().optional(),
  // pg connection-pool tuning. Defaults match the `pg` library defaults so this
  // is backwards-compatible; raise PGPOOL_MAX under load. Timeouts are in ms.
  PGPOOL_MAX: z.coerce.number().int().positive().default(10),
  PGPOOL_IDLE_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(10000),
  // OPS-1: was 0 (infinite wait) — under pool saturation, a request would hang
  // forever instead of failing fast. 5000ms gives pg time to acquire a client
  // under normal load while still bounding worst-case request latency.
  PGPOOL_CONNECTION_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(5000),
  PGAPPNAME: z.string().trim().min(1).default('sellright-api'),
  // WP2: SMTP (all optional — mailer no-ops with a log line when unconfigured).
  // Interface to bind. Default 0.0.0.0 (reverse proxies on a Docker bridge
  // need it); set 127.0.0.1 for local-only instances (tests, rehearsals).
  HOST: z.string().default('0.0.0.0'),
  SMTP_HOST: optionalEnvString,
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: optionalEnvString,
  SMTP_PASS: optionalEnvString,
  SMTP_FROM: optionalEnvEmail,
  // Force the no-op path even when SMTP_HOST is set (load tests, demos).
  SMTP_ENABLED: z.preprocess(emptyToUndefined, z.enum(['true', 'false']).optional()),
  // Vendure Gmail aliases used by Damned/Rotten. Normalized below into SMTP_*.
  GMAIL_USER: optionalEnvEmail,
  EMAIL_PASS: optionalEnvString,
  FROM_EMAIL: optionalEnvEmail,
  // WP8: asset storage directory. Default is contained INSIDE the checkout
  // (<checkout>/var/assets via the packages/api cwd) — never ~/sites root. Each
  // deployment sets ASSET_DIR explicitly in its env (dev vs downstream prod).
  ASSET_DIR: z.string().default('var/assets'),
  // WS-E: maintenance-mode flag file, shared with the job scheduler and
  // polled by the storefront via GET /v1/maintenance. Must live on a volume
  // that survives an `api` container restart (see maintenance.ts).
  MAINTENANCE_FLAG_FILE: z.string().default('var/state/MAINTENANCE'),
  // WP-dl: licensed downloads. Artifacts live in a PRIVATE dir (NOT the
  // nginx-served /assets path) and are streamed by the app behind short-lived
  // HMAC-signed URLs. DOWNLOAD_URL_SECRET signs those URLs — set it in prod; when
  // unset the licensed-download endpoint returns 503 (fail loud, never hand out an
  // unsigned permanent link).
  DOWNLOAD_DIR: z.string().default('var/downloads'),
  DOWNLOAD_URL_SECRET: z.string().optional(),
  // SEC-4: host allowlist for artifact.path values that are external http(s) URLs.
  // Comma-separated list of host suffixes (e.g. "r2.dev,cloudfront.net"). An
  // artifact URL is only redirected to when its hostname equals a listed suffix
  // or is a subdomain of one. Empty (default) allows nothing — release artifacts
  // pointing at an external URL are rejected until an operator opts in a host.
  ARTIFACT_EXTERNAL_HOST_ALLOWLIST: z.string().default(''),
  // Public storefront URL used in email links (password reset, verify, etc.).
  STOREFRONT_URL: z.string().url().default('https://store.example.com'),
  // Optional per-app overrides for shared stores, e.g.
  // viewright=hello@viewright.cc,heardright=hello@heardright.app
  EMAIL_FROM_BY_APP: optionalEnvString,
  // Optional per-app display names for shared stores, e.g.
  // someapp=SomeApp,otherapp=OtherApp
  EMAIL_NAME_BY_APP: optionalEnvString,
  // Optional per-app storefront links for shared stores, e.g.
  // viewright=https://viewright.cc,heardright=https://heardright.app
  STOREFRONT_URL_BY_APP: optionalEnvString,
  // Optional per-STORE (slug, not app) storefront origin override for the
  // Cloudflare cache-purge hook (cache/purge-hook.ts) — e.g.
  // brand-a=https://brand-a.example.com,brand-b=https://brand-b.example.com.
  // Falls back to STOREFRONT_URL for the common single-store deployment.
  STOREFRONT_ORIGIN_BY_STORE: optionalEnvString,
  // Cloudflare cache purge (per-store, optional — disabled/no-op when unset
  // for a given store). Zone id is not secret; the API token is. Both support
  // a per-store "slug=value,slug2=value2" map with a single-store fallback,
  // same convention as EMAIL_FROM_BY_APP. A store with neither its slug nor
  // the fallback configured simply never gets a purge call — cache purge must
  // never become a hard dependency for a catalog/stock write to succeed.
  CLOUDFLARE_ZONE_ID: optionalEnvString,
  CLOUDFLARE_ZONE_ID_BY_APP: optionalEnvString,
  CLOUDFLARE_API_TOKEN: optionalEnvString,
  CLOUDFLARE_API_TOKEN_BY_APP: optionalEnvString,
  // Internal admin cache-purge route (routes/admin-cache.ts). Compared with
  // crypto.timingSafeEqual, fail CLOSED (503) when unset — never fall back to
  // an unauthenticated purge endpoint.
  CACHE_ADMIN_TOKEN: optionalEnvString,
  // Cart lifecycle (CART-04 — owner decision 2026-09-24: 24h retention for
  // idle carts, converted carts/orders untouched):
  //   CART_TTL_DAYS      — hard TTL written to cart.expires_at on every
  //     mutation; cleanup deletes EXPIRED + EMPTY active/merged carts past
  //     it. Default 1 (24h) — was 30.
  //   CART_ABANDON_HOURS — inactivity window after which a cart WITH items
  //     is flagged 'abandoned' (analytics/recovery event; not a deletion).
  //   CART_RETENTION_DAYS — how long an ABANDONED (non-empty) cart is kept
  //     before cleanup purges it. Default 1 (24h) — previously had no env
  //     default at all (opt-in per store, else retained forever). All three
  //     stay overridable per-store via store.config.cart.{ttlDays,
  //     abandonAfterHours,retentionDays} — see cart/ttl.ts. Converted carts
  //     are NEVER purged by any of these knobs; their order is untouched.
  CART_TTL_DAYS: z.coerce.number().int().positive().default(1),
  CART_ABANDON_HOURS: z.coerce.number().int().positive().default(4),
  CART_RETENTION_DAYS: z.coerce.number().int().positive().default(1),
  // WP3: Stripe. Legacy single-key envs still work; optional test/live envs let
  // one deployment hold both credential sets at once for runtime mode toggles.
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  STRIPE_SECRET_KEY_TEST: z.string().optional(),
  STRIPE_SECRET_KEY_LIVE: z.string().optional(),
  STRIPE_WEBHOOK_SECRET_TEST: z.string().optional(),
  STRIPE_WEBHOOK_SECRET_LIVE: z.string().optional(),
  STRIPE_PUBLISHABLE_KEY_TEST: z.string().optional(),
  STRIPE_PUBLISHABLE_KEY_LIVE: z.string().optional(),

  // WS-A: master key for encrypting owner-entered secrets (store_secret table).
  // Infra-only — never stored in the database. See security/secret-crypto.ts.
  SELLRIGHT_MASTER_KEY: z.string().optional(),
  // NMI and Sezzle account profiles. Prefer GATEWAY_ACCOUNTS_JSON_FILE in
  // production so credentials can be mounted without appearing in Compose.
  GATEWAY_ACCOUNTS_JSON: z.string().default('[]'),
  // Google OAuth — consumed by routes/auth.ts (lane G).
  GOOGLE_CLIENT_ID: z.string().optional(),
  // ── Customer session policy (auth/session.ts, routes/auth.ts) ─────────────
  // Defaults preserve the historical SellRight posture: 30-day sessions that do
  // NOT slide. Per-store overrides live in store.config.auth:
  //   sessionTtlDays / renewable / sessionRenewWindowDays.
  // SESSION_TTL_DAYS — session + customer-cookie lifetime. Downstream forks
  //   choose their own (RightSites runs 365); SellRight stays at 30.
  // SESSION_RENEWABLE — when 'true', an authenticated resolve inside the renew
  //   window extends expiresAt server-side (authoritative: the new expiry is
  //   persisted; logout/revocation still kills the token).
  // SESSION_RENEW_WINDOW_DAYS — renew when remaining lifetime drops below this.
  //   A window >= ttl means every authenticated request renews (sliding
  //   sessions that never expire while active) — set it deliberately.
  SESSION_TTL_DAYS: z.coerce.number().positive().default(30),
  SESSION_RENEWABLE: z.preprocess(emptyToUndefined, z.enum(['true', 'false']).default('false')),
  SESSION_RENEW_WINDOW_DAYS: z.coerce.number().positive().default(7),
  // ── Passwordless sign-in (auth/magic-link.ts) ─────────────────────────────
  // Disabled unless a deployment or an individual store opts in — the endpoint
  // 409s when unconfigured. MAGIC_LINK_ENABLED is the fleet-wide default;
  // store.config.auth.magicLink (boolean) overrides per tenant, including an
  // explicit false to opt a store out of an enabled fleet.
  MAGIC_LINK_ENABLED: z.preprocess(emptyToUndefined, z.enum(['true', 'false']).default('false')),
  MAGIC_LINK_TTL_MINUTES: z.coerce.number().positive().default(15),
  // Landing path appended to the resolved storefront URL in the sign-in email.
  // store.config.auth.magicLinkPath overrides per tenant.
  MAGIC_LINK_PATH: z.string().default('/account/magic-link'),
  // Sign in with Apple — accepted identity-token `aud` values, comma-separated
  // (a native app's bundle id and/or a web Services ID). Per-store override:
  // store.config.auth.appleClientId (string or string[]). Empty/absent (the
  // default) = not configured → the endpoint 409s. Never trust a client-
  // supplied bundle id; the audience list is server-side config only.
  APPLE_CLIENT_IDS: optionalEnvString,
  // Contact form / anti-bot (routes/contact.ts, security/turnstile.ts).
  // CONTACT_FORM_SECRET signs the submitter-confirmation link (falls back to
  // LICENSING_HMAC_SECRET → COOKIE_SECRET inside contact.ts); CONTACT_EMAIL is
  // the last-resort team inbox after per-store config; TURNSTILE_SECRET_KEY is
  // the global fallback when a store has no turnstile secret in config.
  CONTACT_FORM_SECRET: z.string().optional(),
  // Legacy fallbacks in the contact-link signing chain (contact.ts).
  LICENSING_HMAC_SECRET: z.string().optional(),
  COOKIE_SECRET: z.string().optional(),
  CONTACT_EMAIL: z.string().email().optional(),
  TURNSTILE_SECRET_KEY: z.string().optional(),
  // Explicit opt-out for stores with no Turnstile secret. In NODE_ENV=production a
  // store with no secret FAILS CLOSED on every Turnstile-gated route unless this is
  // 'true'. Demo/staging deploys without a site key must set TURNSTILE_DISABLED=true.
  TURNSTILE_DISABLED: z.preprocess(emptyToUndefined, z.enum(['true', 'false']).optional()),
  // Entitlement token lifetime (licensing/sign.ts). Shorter TTL = tighter
  // revocation window on a compromised/refunded license. Default 7d; override
  // per-deployment if a longer offline grace period is required.
  ENTITLEMENT_TTL_SECONDS: z.coerce.number().int().positive().optional(),
  // First-run admin + store bootstrap. All optional so existing deployments are
  // unaffected. bootstrap.ts treats a partially configured set as an error and
  // never resets an existing admin password on restart.
  // WS-B: compose.yaml's `${ADMIN_EMAIL:-}` (and PASSWORD) resolve to an empty
  // string, not "unset", whenever the var is absent from deploy/.env — which
  // is now the NORMAL case for a fresh one-click install (install.sh no
  // longer writes either line). Without emptyToUndefined, z.string().email()
  // rejects "" and env.ts's module-level EnvSchema.parse() throws, crash-
  // looping the api container on every install that doesn't set these by
  // hand. `optionalEnvString`/`optionalEnvEmail` are ALREADY this repo's
  // convention for exactly this (see BOOTSTRAP_STORE_SLUG) — these two had
  // just never been switched over.
  ADMIN_EMAIL: optionalEnvEmail,
  ADMIN_PASSWORD: optionalEnvString,
  BOOTSTRAP_STORE_SLUG: optionalEnvString,
  // WS-E: which store `functional-check.js` dry-runs a cart against.
  // Defaults to BOOTSTRAP_STORE_SLUG so single-store installs need no extra
  // config; set explicitly to point the update's dry run at a dedicated,
  // non-production test store instead.
  FUNCTIONAL_CHECK_STORE_SLUG: optionalEnvString,
  // WS-E: test/CI-only escape hatch to deterministically fail
  // functional-check.js without needing a real broken migration or DB outage
  // — used by the appliance CI job that proves `sellright update` actually
  // rolls back when a functional check fails. Never read anywhere except
  // functional-check.ts's own final report.
  FUNCTIONAL_CHECK_FORCE_FAIL: z.preprocess(emptyToUndefined, z.enum(['true', 'false']).optional()),
  BOOTSTRAP_STORE_NAME: optionalEnvString,
  BOOTSTRAP_STORE_CURRENCY: z.preprocess(emptyToUndefined, z.string().regex(/^[A-Za-z]{3}$/).transform((v) => v.toUpperCase()).optional()),
  BOOTSTRAP_STORE_HOSTNAMES: optionalEnvString,
  // Public storefront URL written to store.config.storefrontUrl on first-run bootstrap (https; http only for loopback).
  BOOTSTRAP_STORE_URL: optionalEnvString,
  // Import scripts: Vendure source DB (read-only clone used by catalog/customers/orders importers).
  SOURCE_DATABASE_URL: z.string().url().optional(),
  // Import scripts: TRUNCATE guard override — BOTH --force argv AND ALLOW_FORCE_TRUNCATE=1
  // must be set to allow a truncating import against a non-dev/test DB.
  // ⚠ DANGER: Setting this to '1' in production will permit mass data deletion.
  ALLOW_FORCE_TRUNCATE: z.enum(['0', '1']).optional(),
  // Manifest generator: output directory for static JSON catalog files.
  CATALOG_DIR: z.string().optional(),
  // Manifest generator / multi-store: which store to generate for.
  STORE_SLUG: z.string().optional(),
  CATALOG_MANIFEST_JOBS_ENABLED: z.enum(['0', '1']).default('0'),
  // SELLRIGHT-ISSUES P1: shared rate-limit backend. 'postgres' (default) is
  // shared across every API process via the rate_limit_attempt table
  // (migration 0078) — a process-local in-memory limiter is silently
  // ineffective the moment there's more than one API instance. 'memory' is
  // an explicit single-process opt-out (also what tests use, since the unit
  // lane runs with no database). Never Redis — Postgres is the store's
  // already-required dependency.
  RATE_LIMIT_BACKEND: z.enum(['postgres', 'memory']).optional(),
  // APNs (mobile push for the admin app). ALL optional — with any of them unset
  // the push sender no-ops with a log line, exactly like the SMTP mailer. A
  // deployment without a mobile app never has to think about these.
  //   APNS_KEY_P8 — contents of the .p8 token key from the Apple developer
  //   account (BEGIN PRIVATE KEY block). Accepts literal newlines or \n-escaped.
  //   NEVER commit it; it signs pushes for every app under the team.
  APNS_KEY_P8: optionalEnvString,
  APNS_KEY_ID: optionalEnvString,
  APNS_TEAM_ID: optionalEnvString,
  APNS_BUNDLE_ID: optionalEnvString, // e.g. app.sellright.ios.admin
  // Which APNs host to use for tokens registered without an explicit
  // environment. TestFlight/App Store builds are 'production'; a Debug build
  // signed with a development profile mints SANDBOX tokens — pushing those to
  // the production host silently fails with BadDeviceToken. The app reports its
  // own environment at registration; this is only the fallback.
  APNS_DEFAULT_ENVIRONMENT: z.enum(['production', 'sandbox']).default('production'),
  // StoreKit (Apple In-App Purchase) — deployment-wide verification knobs for
  // licensing/storekit-*.ts + routes/storekit-webhooks.ts. Per-app config
  // (bundleId, appAppleId, product→entitlement map, sandbox policy) lives in
  // the storekit_app table, NEVER in env or request input; these are only the
  // global gates.
  // STOREKIT_ONLINE_CHECKS: '1' (default) enables Apple's online OCSP
  //   revocation checking during JWS verification. Set '0' only on networks
  //   that cannot reach Apple's OCSP responders (offline dev/CI) — production
  //   must keep it on.
  STOREKIT_ONLINE_CHECKS: z.enum(['0', '1']).default('1'),
  // STOREKIT_ALLOW_SANDBOX: '1' (default) permits Sandbox-environment
  //   purchases (TestFlight — Apple always uses Sandbox there) wherever the
  //   per-app storekit_app.allow_sandbox row also allows it. '0' is a
  //   deployment-wide kill switch rejecting every Sandbox transaction.
  STOREKIT_ALLOW_SANDBOX: z.enum(['0', '1']).default('1'),
  // Job scheduler: master on/off switch (default off — safe for dev/test).
  JOBS_ENABLED: z.enum(['0', '1']).optional(),
  // push sender: deliver queued pushes (default off — the outbox still fills,
  // so enabling it later doesn't lose the alerts already queued).
  JOBS_PUSH_ENABLED: z.enum(['0', '1']).optional(),
  // auto-deliver job: actually transition Shipped→Delivered (default: dry-run log only).
  JOBS_AUTO_DELIVER_APPLY: z.enum(['0', '1']).optional(),
  // auto-deliver job: age threshold in days before Shipped becomes Delivered.
  JOBS_AUTO_DELIVER_DAYS: z.coerce.number().int().positive().optional(),
  // release-stale-allocations job: actually cancel + release (default: dry-run).
  // ⚠ DANGER: Enabling against imported historical PendingPayment orders will mass-cancel them.
  JOBS_RELEASE_STALE_APPLY: z.enum(['0', '1']).optional(),
  // release-stale-allocations job: unpaid-order age threshold in minutes.
  JOBS_RELEASE_STALE_TTL_MIN: z.coerce.number().int().positive().optional(),
  // PAYMENT-TIMING §5.4 (decision X-10): age after which an unconfirmed Stripe PaymentIntent is cancelled at Stripe. Default 60.
  PAYMENT_INTENT_DEADLINE_MIN: z.coerce.number().int().positive().optional(),
  // webhook-reaper job: actually reset stuck processing rows (default: dry-run).
  JOBS_WEBHOOK_REAPER_APPLY: z.enum(['0', '1']).optional(),
  // webhook-reaper job: grace period in minutes before a processing row is considered stuck.
  JOBS_WEBHOOK_REAPER_GRACE_MIN: z.coerce.number().int().positive().optional(),
  // processed-event-reaper job: actually delete aged rows (default: dry-run).
  JOBS_PROCESSED_EVENT_REAPER_APPLY: z.enum(['0', '1']).optional(),
  // processed-event-reaper job: retention window in days before a
  // processed_event row (webhook id / payment idempotency claim) is reaped.
  // Kept well above any realistic idempotency window on purpose (see
  // jobs/processed-event-reaper.ts) — never lower this without checking the
  // longest replay/retry window the payment provider guarantees.
  JOBS_PROCESSED_EVENT_REAPER_RETENTION_DAYS: z.coerce.number().int().positive().optional(),
  // gateway-recovery job (payments D7/D8): auto-verify stuck NMI/Sezzle
  // attempts. Applies by default (like gateway-events); '0' = dry-run log only.
  JOBS_GATEWAY_RECOVERY_APPLY: z.enum(['0', '1']).optional(),
  // Minimum attempt age (minutes) before recovery touches it.
  JOBS_GATEWAY_RECOVERY_AGE_MIN: z.coerce.number().int().positive().optional(),
  // Verification tries before an attempt is flagged for manual review.
  JOBS_GATEWAY_RECOVERY_MAX_ATTEMPTS: z.coerce.number().int().positive().optional(),
  // Unapproved Sezzle checkout sessions older than this (minutes) are expired.
  SEZZLE_SESSION_EXPIRY_MIN: z.coerce.number().int().positive().optional(),
  // SEC-5: only honor CF-Connecting-IP for rate-limit/audit IP resolution when the
  // deployment is actually behind Cloudflare's edge. Without this, any store not
  // behind Cloudflare lets a client set that header itself and defeat rate limiting.
  // '1' opts in; default '0' (off) is the safe posture for a fresh deployment.
  BEHIND_CLOUDFLARE: z.enum(['0', '1']).default('0'),
  // Header trusted for client IP when NOT behind Cloudflare (e.g. our own nginx's
  // X-Real-IP). Must be set by a proxy the deployment actually controls.
  TRUSTED_PROXY_HEADER: z.string().default('x-real-ip'),
  // SEC-5: expose raw error messages to clients regardless of NODE_ENV. Only ever
  // set '1' for local debugging — a staging box left without NODE_ENV=production
  // must NOT leak internal error text by default.
  DEBUG_ERRORS: z.enum(['0', '1']).default('0'),

  // ── Extension seams (generic — a downstream fork's runtime config only;
  //    every default below reproduces SellRight's own prior hardcoded
  //    behavior, so an unconfigured deployment is byte-for-byte unchanged) ──
  //
  // DEV_DEFAULT_STORE_SLUG: the store slug resolveStoreForRequest() falls back
  // to outside production when no x-store-slug header or Host match resolves
  // a store (store-context.ts). A fork points this at its own seed store
  // instead of editing store-context.ts.
  DEV_DEFAULT_STORE_SLUG: z.string().trim().min(1).default('damned'),
  // FORBIDDEN_SENDER_DOMAINS: comma-separated domain suffixes that must never
  // appear as an outgoing email's From domain. Checked once here at boot
  // (SMTP_FROM/FROM_EMAIL/EMAIL_FROM_BY_APP) and again per-send in
  // email/mailer.ts via the same matcher (email/sender-policy.ts). Empty
  // (default) enforces nothing.
  FORBIDDEN_SENDER_DOMAINS: z.string().default(''),
  // STORE_HOST_STRIP_PREFIXES: comma-separated single-label hostname prefixes
  // (e.g. "www,buy,get,store") stripped from an incoming Host before matching
  // store.config.hostnames (store-context.ts stripHostPrefix). Empty
  // (default) strips nothing — identical to today's exact/subdomain matching.
  STORE_HOST_STRIP_PREFIXES: z.string().default(''),
  // APPS_APP_KEY_HEADERS: comma-separated request header names checked, in
  // order, for an explicit app key on the public apps/licensing routes
  // (routes/apps.ts). Default reproduces the historical literal headers.
  APPS_APP_KEY_HEADERS: z.string().default('x-viewright-app,x-app-key'),
  // APPS_DEVICE_HEADER / APPS_LICENSE_HEADER: header names for the device id
  // and the legacy bearer-alternative license key on the same routes.
  APPS_DEVICE_HEADER: z.string().trim().min(1).default('x-viewright-device'),
  APPS_LICENSE_HEADER: z.string().trim().min(1).default('x-viewright-license'),
  // APPS_FALLBACK_STORE_SLUG: when set, publicAppStore() falls back to this
  // store slug after an unknown per-app-key store lookup fails — lets a
  // consolidated multi-tenant deployment share one store across app keys
  // without a literal slug in routes/apps.ts. Unset (default): an unknown
  // appKey 404s, exactly as today.
  APPS_FALLBACK_STORE_SLUG: optionalEnvString,
}).transform((raw) => {
  const smtpUser = raw.SMTP_USER ?? raw.GMAIL_USER;
  return {
    ...raw,
    SMTP_HOST: raw.SMTP_HOST ?? (smtpUser ? 'smtp.gmail.com' : undefined),
    SMTP_USER: smtpUser,
    SMTP_PASS: raw.SMTP_PASS ?? raw.EMAIL_PASS,
    SMTP_FROM: raw.SMTP_FROM ?? raw.FROM_EMAIL ?? raw.GMAIL_USER ?? 'noreply@sellright.local',
  };
});

export type Env = z.infer<typeof EnvSchema>;
export type EnvSource = Record<string, string | undefined>;

/**
 * Parse and validate an environment source into the engine `Env`. Pure: it
 * touches no module state, so `createApp({ env })` (sdk/create-app.ts) and the
 * lazy singleton below share one code path. File-backed secrets (`KEY_FILE`)
 * are resolved first; production gates and the sender-domain policy run here.
 */
export function parseEnv(source: EnvSource): { env: Env; resolvedSource: EnvSource } {
  const resolvedSource = resolveFileBackedEnv(source);
  const parsed: Env = EnvSchema.parse(resolvedSource);
  const productionErrors = productionEnvErrors(parsed, resolvedSource);
  if (productionErrors.length) {
    throw new Error(`Invalid production environment:\n- ${productionErrors.join('\n- ')}`);
  }
  // Shared sender-domain policy (email/sender-policy.ts) — no-op while
  // FORBIDDEN_SENDER_DOMAINS is unset (the default).
  assertAllowedSenders(
    { SMTP_FROM: parsed.SMTP_FROM, FROM_EMAIL: parsed.FROM_EMAIL, EMAIL_FROM_BY_APP: parsed.EMAIL_FROM_BY_APP },
    parseSenderDomainList(parsed.FORBIDDEN_SENDER_DOMAINS),
  );
  return { env: parsed, resolvedSource };
}

// ---------------------------------------------------------------------------
// Process-wide env holder. Importing this module parses NOTHING (2.1: env is
// parsed inside createApp). `initEnv` is called by createApp with its `env`
// option; code paths that never go through createApp (operator scripts, the
// test runner, the legacy `buildHttpApp()` builder) keep working because the
// first read of `env` initialises it implicitly from `process.env`. An implicit
// init is recorded so createApp can refuse to run after a module touched the
// env at import time (that would mean the env was NOT parsed inside createApp).
// ---------------------------------------------------------------------------
interface EnvState { env: Env; source: EnvSource; origin: 'explicit' | 'implicit'; closed?: boolean }
let envState: EnvState | undefined;

export function initEnv(source: EnvSource = process.env): Env {
  const { env: parsed, resolvedSource } = parseEnv(source);
  envState = { env: parsed, source: resolvedSource, origin: 'explicit' };
  return parsed;
}

export function getEnv(): Env {
  if (envState) return envState.env;
  const { env: parsed, resolvedSource } = parseEnv(process.env);
  envState = { env: parsed, source: resolvedSource, origin: 'implicit' };
  return parsed;
}

/** The resolved raw source the env was parsed from. INTERNAL: contains secrets; use only to fingerprint them. */
export function getEnvSource(): EnvSource {
  getEnv();
  return envState!.source;
}

/** The current env if one has been initialised, else undefined (never initialises). */
export function peekEnv(): Env | undefined {
  return envState?.env;
}

/** 'explicit' (createApp), 'implicit' (first-touch from process.env) or undefined. */
export function envOrigin(): 'explicit' | 'implicit' | undefined {
  return envState && !envState.closed ? envState.origin : undefined;
}

/**
 * Mark the env closed (createApp shutdown). The parsed values stay READABLE so a straggler
 * (a fire-and-forget promise finishing after shutdown) reads config instead of throwing and
 * turning a clean shutdown into an unhandled rejection (review F4); `envOrigin()` reports
 * undefined so the next createApp may initialise afresh.
 */
export function closeEnv(): void {
  if (envState) envState.closed = true;
}

/** Test-only: forget everything so the next read re-initialises from process.env. */
export function _resetEnvForTest(): void {
  envState = undefined;
}

/**
 * The engine env. A lazy view over the current holder: reads, writes (tests set
 * flags), `in`, and enumeration all forward to the live parsed object.
 */
export const env: Env = new Proxy({} as Env, {
  get: (_t, key) => Reflect.get(getEnv(), key),
  set: (_t, key, value) => Reflect.set(getEnv(), key, value),
  has: (_t, key) => Reflect.has(getEnv(), key),
  ownKeys: () => Reflect.ownKeys(getEnv()),
  getOwnPropertyDescriptor: (_t, key) => {
    const d = Reflect.getOwnPropertyDescriptor(getEnv(), key);
    if (d) d.configurable = true;
    return d;
  },
});

/**
 * Extension seam: parse additional, deployment-specific env vars from the
 * same resolved source the engine env was parsed from, without editing this
 * file. A fork defines its own zod shape (and optional boot-time validator) and
 * gets back one merged, frozen object carrying both SellRight's `env` and its
 * own typed extras.
 *
 * This runs a SEPARATE `z.object(extraShape).parse(...)` over the same
 * resolved source — it never re-runs this file's own `.transform()` — so
 * SellRight's own defaults/normalization above are untouched. `validate`
 * receives the merged object and may return an array of error strings; a
 * non-empty array throws, matching this file's own productionEnvErrors gate.
 * Inside createApp, plugins reach it as `ctx.extendEnv` (the `configure` phase).
 */
export function extendEnv<Extra extends z.ZodRawShape>(
  extraShape: Extra,
  validate?: (merged: Readonly<Env & z.infer<z.ZodObject<Extra>>>) => string[] | void,
): Readonly<Env & z.infer<z.ZodObject<Extra>>> {
  getEnv();
  const extra = z.object(extraShape).parse(envState!.source);
  const merged = Object.freeze({ ...envState!.env, ...extra }) as Env & z.infer<z.ZodObject<Extra>>;
  const errors = validate?.(merged);
  if (errors && errors.length) {
    throw new Error(`Invalid extended environment:\n- ${errors.join('\n- ')}`);
  }
  return merged;
}
