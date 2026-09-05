import { readFileSync } from 'node:fs';

const FILE_BACKED_KEYS = [
  'DATABASE_URL',
  'DATABASE_URL_NONOWNER',
  'SMTP_PASS',
  'EMAIL_PASS',
  'DOWNLOAD_URL_SECRET',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_SECRET_KEY_TEST',
  'STRIPE_SECRET_KEY_LIVE',
  'STRIPE_WEBHOOK_SECRET_TEST',
  'STRIPE_WEBHOOK_SECRET_LIVE',
  'ADMIN_PASSWORD',
  'SOURCE_DATABASE_URL',
  'APNS_KEY_P8',
] as const;

export type EnvSource = Record<string, string | undefined>;

type ReadTextFile = (path: string) => string;

/**
 * Resolve Docker/Kubernetes-style KEY_FILE=/run/secrets/... values before zod
 * validation. A direct KEY always wins over KEY_FILE, so an operator can
 * override mounted secrets explicitly. Only a fixed allowlist is file-backed;
 * arbitrary environment names cannot make the process read arbitrary files.
 */
export function resolveFileBackedEnv(
  source: EnvSource,
  readTextFile: ReadTextFile = (path) => readFileSync(path, 'utf8'),
): EnvSource {
  const resolved: EnvSource = { ...source };
  for (const key of FILE_BACKED_KEYS) {
    if (resolved[key] != null && resolved[key] !== '') continue;
    const path = source[`${key}_FILE`];
    if (!path) continue;
    // Mounted secret files conventionally end with a single newline. Remove
    // trailing CR/LF only; do not trim spaces or internal newlines (APNs .p8).
    resolved[key] = readTextFile(path).replace(/[\r\n]+$/u, '');
  }
  return resolved;
}

export type ProductionEnvView = {
  NODE_ENV: 'development' | 'test' | 'production';
  DATABASE_URL: string;
  STOREFRONT_URL: string;
};

/** Invariants that must hold for a production boot, independent of zod shape. */
export function productionEnvErrors(env: ProductionEnvView, source: EnvSource): string[] {
  if (env.NODE_ENV !== 'production') return [];
  const errors: string[] = [];
  if (!source.DATABASE_URL) {
    errors.push('DATABASE_URL must be explicitly configured in production (directly or via DATABASE_URL_FILE)');
  }
  if (/sellright_(dev|test)(?:\b|[?/#])/i.test(env.DATABASE_URL) || /[:/]5433\//.test(env.DATABASE_URL)) {
    errors.push('DATABASE_URL points at a development/test-looking database or the reserved :5433 development port');
  }
  try {
    const host = new URL(env.STOREFRONT_URL).hostname.toLowerCase();
    if (host === 'example.com' || host.endsWith('.example.com')) {
      errors.push('STOREFRONT_URL must be a real deployment URL in production, not example.com');
    }
  } catch {
    // zod reports malformed URLs before this function is called.
  }
  return errors;
}
