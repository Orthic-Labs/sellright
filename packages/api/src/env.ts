import { z } from 'zod';

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
  PGPOOL_CONNECTION_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(0),
  // WP2: SMTP (all optional — mailer no-ops with a log line when unconfigured).
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().email().default('noreply@sellright.local'),
  // Force the no-op path even when SMTP_HOST is set (load tests, demos).
  SMTP_ENABLED: z.enum(['true', 'false']).optional(),
  // WP8: asset storage directory. Default is contained INSIDE the checkout
  // (<checkout>/var/assets via the packages/api cwd) — never ~/sites root. Each
  // deployment sets ASSET_DIR explicitly in its env (dev vs rightapps prod).
  ASSET_DIR: z.string().default('var/assets'),
  // Public storefront URL used in email links (password reset, verify, etc.).
  STOREFRONT_URL: z.string().url().default('https://store.example.com'),
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
  // Job scheduler: master on/off switch (default off — safe for dev/test).
  JOBS_ENABLED: z.enum(['0', '1']).optional(),
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
});

export type Env = z.infer<typeof EnvSchema>;

export const env: Env = EnvSchema.parse(process.env);
