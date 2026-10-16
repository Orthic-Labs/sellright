/**
 * `config/v1` — the versioned, secret-free projection of what this runtime is
 * actually configured to do (plan 2.7). Two sections:
 *
 *  - `intended`: content that must be identical between the old and new runtime
 *    (store config content fingerprints, auth flags, env-derived non-secret values,
 *    secret-material fingerprints). 7.1 compares it for equality.
 *  - `deployment`: operational facts (build, port, paths, database host, provider
 *    mode/account ids, job state). 7.1 compares it against an approved old/new table.
 *
 * Secrets appear ONLY as fingerprints (fingerprint.ts). The route is read-only and
 * gated on the per-store `owner` role.
 */
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Env } from '../env.js';
import type { AdminStoreAccess } from '../auth/admin-session.js';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { storeAuthConfig } from '../auth/session.js';
import { magicLinkPolicy } from '../auth/magic-link.js';
import { sessionPolicy } from '../auth/session.js';
import { stripeModeFromConfig } from '../payments/stripe.js';
import { gatewayModeFromConfig } from '../payments/gateway-account.js';
import { isMaintenanceOn } from '../maintenance.js';
import { collectBuildInfo } from './build-info.js';
import { fingerprintSha256, saltedFingerprints } from './fingerprint.js';
import { installationFingerprintSalt } from './installation-salt.js';
import { signingPublicKeyFingerprint } from '../licensing/sign.js';
import { getEngineState } from './engine-state.js';
import type { PluginEffectiveConfig } from './types.js';

export const CONFIG_SCHEMA_VERSION = 'config/v1' as const;

/** Deterministic JSON: object keys sorted recursively. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function contentFingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** Symmetric / bearer secrets the engine reads (env name -> fingerprint kind). process.env-only names are read live. */
const SYMMETRIC_ENV_SECRETS = [
  'COOKIE_SECRET', 'LICENSING_HMAC_SECRET', 'DOWNLOAD_URL_SECRET', 'CONTACT_FORM_SECRET',
  'SELLRIGHT_MASTER_KEY', 'CACHE_ADMIN_TOKEN', 'CLOUDFLARE_API_TOKEN',
  'STRIPE_SECRET_KEY', 'STRIPE_SECRET_KEY_TEST', 'STRIPE_SECRET_KEY_LIVE',
  'STRIPE_WEBHOOK_SECRET', 'STRIPE_WEBHOOK_SECRET_TEST', 'STRIPE_WEBHOOK_SECRET_LIVE',
  'SMTP_PASS', 'TURNSTILE_SECRET_KEY', 'APNS_KEY_P8', 'GATEWAY_ACCOUNTS_JSON',
] as const;

function keyMode(key: string | undefined): 'live' | 'test' | 'other' | null {
  if (!key) return null;
  if (key.includes('_live_')) return 'live';
  if (key.includes('_test_')) return 'test';
  return 'other';
}

function databaseIdentity(url: string): { host: string; port: string; database: string; role: string } {
  try {
    const u = new URL(url);
    return { host: u.hostname, port: u.port || '5432', database: decodeURIComponent(u.pathname.replace(/^\//, '')), role: decodeURIComponent(u.username) };
  } catch {
    return { host: '(unparseable)', port: '', database: '', role: '' };
  }
}

/** Non-secret env values the storefront/engine behaviour depends on. */
function nonSecretEnv(env: Env): Record<string, unknown> {
  return {
    NODE_ENV: env.NODE_ENV,
    STOREFRONT_URL: env.STOREFRONT_URL,
    SESSION_TTL_DAYS: env.SESSION_TTL_DAYS,
    SESSION_RENEWABLE: env.SESSION_RENEWABLE,
    MAGIC_LINK_ENABLED: env.MAGIC_LINK_ENABLED,
    DEV_DEFAULT_STORE_SLUG: env.DEV_DEFAULT_STORE_SLUG,
    SMTP_ENABLED: env.SMTP_ENABLED ?? null,
    SMTP_FROM: env.SMTP_FROM,
    FORBIDDEN_SENDER_DOMAINS: env.FORBIDDEN_SENDER_DOMAINS ?? null,
    APPS_APP_KEY_HEADERS: env.APPS_APP_KEY_HEADERS,
    APPS_FALLBACK_STORE_SLUG: env.APPS_FALLBACK_STORE_SLUG ?? null,
    ARTIFACT_EXTERNAL_HOST_ALLOWLIST: env.ARTIFACT_EXTERNAL_HOST_ALLOWLIST,
  };
}

export interface EffectiveConfigInput {
  env: Env;
  /** Raw env source the engine was created from (secrets are read from it ONLY to fingerprint). */
  source: Record<string, string | undefined>;
  store: AdminStoreAccess;
}

export async function projectEffectiveConfig({ env, source, store }: EffectiveConfigInput) {
  const [row] = await withStore(store.storeId, (tx) =>
    tx.select({ slug: s.store.slug, config: s.store.config }).from(s.store).where(eq(s.store.id, store.storeId)).limit(1));
  const config = (row?.config ?? {}) as Record<string, unknown>;

  const hostnames = Array.isArray(config.hostnames) ? config.hostnames.filter((h): h is string => typeof h === 'string') : [];
  const legalRaw = config.legalManifests && typeof config.legalManifests === 'object' && !Array.isArray(config.legalManifests)
    ? (config.legalManifests as Record<string, unknown>) : {};
  const legalManifests: Record<string, string> = {};
  for (const app of Object.keys(legalRaw).sort()) legalManifests[app] = contentFingerprint(legalRaw[app]);

  const auth = storeAuthConfig(config);
  const magic = magicLinkPolicy(config);
  const session = sessionPolicy(config);

  const fp = saltedFingerprints(await installationFingerprintSalt());
  const secrets: Record<string, { set: boolean; fingerprint: string | null }> = {
    LICENSE_SIGNING_KEY: signingPublicKeyFingerprint(),
  };
  // SELLRIGHT_MASTER_KEY is read live from process.env by security/secret-crypto.ts; report what the runtime uses.
  for (const name of SYMMETRIC_ENV_SECRETS) secrets[name] = fp.symmetric(name === 'SELLRIGHT_MASTER_KEY' ? process.env[name] : source[name], name);

  const state = getEngineState();
  const version = state?.version ?? '0.0.0';
  const pluginSections: Record<string, PluginEffectiveConfig> = {};
  for (const plugin of state?.plugins ?? []) {
    if (plugin.effectiveConfig) pluginSections[plugin.name] = await plugin.effectiveConfig(state!.ctx, fp);
  }
  const pluginIntended = Object.fromEntries(Object.entries(pluginSections).map(([k, v]) => [k, v.intended ?? {}]));
  const pluginDeployment = Object.fromEntries(Object.entries(pluginSections).map(([k, v]) => [k, v.deployment ?? {}]));

  const paymentAccounts = (config.paymentAccounts && typeof config.paymentAccounts === 'object' ? config.paymentAccounts : {}) as Record<string, unknown>;
  const jobs = state?.jobs() ?? { enabled: false, names: [] };
  const db = databaseIdentity(env.DATABASE_URL);

  return {
    schema: CONFIG_SCHEMA_VERSION,
    store: { slug: row?.slug ?? store.slug },
    intended: {
      storeConfig: {
        hostnames,
        legalManifests,
        auth: {
          magicLink: magic.enabled,
          magicLinkTtlMinutes: magic.ttlMinutes,
          magicLinkPath: magic.path,
          sessionTtlDays: session.ttlMs / 86_400_000,
          renewable: session.renewable,
          sessionRenewWindowDays: session.renewWindowMs / 86_400_000,
          overrides: Object.keys(auth).sort(),
        },
        contentFingerprint: contentFingerprint(config),
      },
      env: nonSecretEnv(env),
      secrets,
      plugins: pluginIntended,
    },
    deployment: {
      build: collectBuildInfo(version),
      process: { pid: process.pid, startedAt: state?.startedAt.toISOString() ?? null },
      port: state?.port() ?? null,
      configuredPort: env.PORT,
      host: env.HOST,
      paths: {
        assetDir: env.ASSET_DIR,
        downloadDir: env.DOWNLOAD_DIR,
        maintenanceFlagFile: env.MAINTENANCE_FLAG_FILE,
        catalogDir: env.CATALOG_DIR ?? null,
      },
      database: db,
      providers: {
        stripe: {
          mode: stripeModeFromConfig(config),
          keyModes: { test: keyMode(source.STRIPE_SECRET_KEY_TEST ?? source.STRIPE_SECRET_KEY), live: keyMode(source.STRIPE_SECRET_KEY_LIVE) },
          webhookSecretsSet: {
            test: Boolean(source.STRIPE_WEBHOOK_SECRET_TEST ?? source.STRIPE_WEBHOOK_SECRET),
            live: Boolean(source.STRIPE_WEBHOOK_SECRET_LIVE),
          },
        },
        nmi: { mode: gatewayModeFromConfig(config, 'nmi'), accountId: typeof paymentAccounts.nmi === 'string' ? paymentAccounts.nmi : null },
        sezzle: { mode: gatewayModeFromConfig(config, 'sezzle'), accountId: typeof paymentAccounts.sezzle === 'string' ? paymentAccounts.sezzle : null },
      },
      jobs: {
        enabled: jobs.enabled,
        configured: env.JOBS_ENABLED === '1',
        names: [...jobs.names],
        maintenance: isMaintenanceOn(),
      },
      migrations: state?.migrations() ?? null,
      plugins: pluginDeployment,
      pluginNames: (state?.plugins ?? []).map((p) => p.name),
    },
  };
}

// Re-exported so tests can assert on the helper without importing two modules.
export { fingerprintSha256 };
