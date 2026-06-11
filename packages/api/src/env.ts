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
  // WP2: SMTP (all optional — mailer no-ops with a log line when unconfigured).
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().email().default('noreply@sellright.local'),
  // Force the no-op path even when SMTP_HOST is set (load tests, demos).
  SMTP_ENABLED: z.enum(['true', 'false']).optional(),
  // WP8: asset storage directory (default works for the on-box dev layout).
  ASSET_DIR: z.string().default('/home/vendure/sites/sellright-assets'),
  // Public storefront URL used in email links (password reset, verify, etc.).
  STOREFRONT_URL: z.string().url().default('https://store.example.com'),
  // WP3: Stripe (optional — the provider/endpoints no-op or 503 when unset, so
  // dev/tests boot without a key; only the live end-to-end run needs them).
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export const env: Env = EnvSchema.parse(process.env);
