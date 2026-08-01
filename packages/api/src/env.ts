import { z } from 'zod';

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
  // deployment sets ASSET_DIR explicitly in its env (dev vs rightapps prod).
  ASSET_DIR: z.string().default('var/assets'),
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
  // Optional per-app storefront links for shared stores, e.g.
  // viewright=https://viewright.cc,heardright=https://heardright.app
  STOREFRONT_URL_BY_APP: optionalEnvString,
  // Cart lifecycle: hard TTL (cleanup deletes past this) + inactivity window
  // after which a cart with items is marked abandoned (analytics/recovery).
  CART_TTL_DAYS: z.coerce.number().int().positive().default(30),
  CART_ABANDON_HOURS: z.coerce.number().int().positive().default(4),
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
  // Google OAuth — consumed by routes/auth.ts (lane G).
  GOOGLE_CLIENT_ID: z.string().optional(),
  // Admin bootstrap scripts (seed-admin, provision-right-apps).
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().optional(),
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

export const env: Env = EnvSchema.parse(process.env);
