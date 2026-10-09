// Playwright webServer command for the API under test (fresh-API mode, same pattern as packages/admin/e2e/support):
//
//  1. drop + recreate the throwaway database (guarded: name must end in _e2e and not be a dev/prod DB),
//  2. apply migrations and bootstrap the e2e store + owner from the BUILT api (packages/api/dist) — everything else
//     (catalog, shipping, gateways, ...) is seeded over the admin API by global-setup.ts,
//  3. exec the API on :3398 with the gateway seam preloaded (preload.mjs), an SMTP sink, and the scheduler on.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  API_DIR, API_PORT, DB_ADMIN_URL, DB_APP_URL, DB_NAME, DB_OWNER_URL, MOCK_URL, OWNER_EMAIL, OWNER_PASSWORD, RUN_DIR,
  SMTP_PORT, STORE_SLUG, STORE_URL, HOOK_SENTINEL, SEZZLE, SEZZLE_ACCOUNT, assertSafeTargets, STOREFRONT_DIR,
} from './env.mjs';

assertSafeTargets();

const apiEntry = join(API_DIR, 'dist', 'index.js');
for (const f of [apiEntry, join(API_DIR, 'dist', 'scripts', 'migrate.js'), join(API_DIR, 'dist', 'scripts', 'bootstrap.js')]) {
  if (!existsSync(f)) {
    console.error(`[e2e] ${f} is missing — run \`pnpm --filter @sellright/api build\` first`);
    process.exit(1);
  }
}
mkdirSync(RUN_DIR, { recursive: true });

const { Client } = createRequire(join(API_DIR, 'package.json'))('pg');

async function resetDatabase() {
  const admin = new Client({ connectionString: DB_ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${DB_NAME}"`);
  } finally {
    await admin.end();
  }
}

// Same non-owner RLS role the CI `database`/storefront jobs create: the API refuses to serve as a superuser.
async function grantAppRole() {
  if (DB_APP_URL === DB_OWNER_URL) return;
  const app = new URL(DB_APP_URL);
  const role = decodeURIComponent(app.username);
  const password = decodeURIComponent(app.password).replace(/'/g, "''");
  const owner = new Client({ connectionString: DB_OWNER_URL });
  await owner.connect();
  try {
    await owner.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
        CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
      END IF; END $$`);
    await owner.query(`GRANT CONNECT ON DATABASE "${DB_NAME}" TO "${role}"`);
    await owner.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await owner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${role}"`);
    await owner.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${role}"`);
  } finally {
    await owner.end();
  }
}

// Minimal, explicit environment: nothing from the operator's shell (gateway keys, dev DB URLs, ...) leaks in.
const baseEnv = {
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? '',
  NODE_ENV: 'production',
  STOREFRONT_URL: STORE_URL,
  DOWNLOAD_URL_SECRET: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
  SELLRIGHT_MASTER_KEY: '1122334455667788112233445566778811223344556677881122334455667788',
  ADMIN_EMAIL: OWNER_EMAIL,
  ADMIN_PASSWORD: OWNER_PASSWORD,
  BOOTSTRAP_STORE_SLUG: STORE_SLUG,
  E2E_STORE_SLUG: STORE_SLUG,
  BOOTSTRAP_STORE_NAME: 'E2E Store',
  BOOTSTRAP_STORE_CURRENCY: 'USD',
  // Bare host, no port: store-context strips :port before matching, so the storefront SSR (127.0.0.1:4398) and a
  // direct API call (127.0.0.1:3398) both resolve to this store.
  BOOTSTRAP_STORE_HOSTNAMES: '127.0.0.1',
  RATE_LIMIT_BACKEND: 'memory',
  HOST: '127.0.0.1',
  PORT: String(API_PORT),
};

function runStep(script, databaseUrl) {
  const r = spawnSync(process.execPath, [join(API_DIR, 'dist', 'scripts', script)], {
    cwd: RUN_DIR, env: { ...baseEnv, DATABASE_URL: databaseUrl }, stdio: 'inherit',
  });
  if (r.status !== 0) {
    console.error(`[e2e] ${script} failed (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
}

await resetDatabase();
runStep('migrate.js', DB_OWNER_URL);
runStep('bootstrap.js', DB_OWNER_URL);
await grantAppRole();

// Sezzle credentials come from server configuration (GATEWAY_ACCOUNTS_JSON + store.config.paymentAccounts, set in
// global-setup). They cannot be saved through the admin Payments API: that endpoint stores Sezzle keys under the
// 'sandbox'/'production' modes, while the runtime resolver reads 'test'/'live' (product bug, see the money-sezzle spec).
// The account JSON is keyed by store id, which only exists after bootstrap.
async function gatewayAccountsJson() {
  const c = new Client({ connectionString: DB_OWNER_URL });
  await c.connect();
  try {
    const { rows } = await c.query('SELECT id FROM store WHERE slug = $1', [STORE_SLUG]);
    if (!rows[0]) throw new Error(`bootstrap did not create store ${STORE_SLUG}`);
    return JSON.stringify([{ accountId: SEZZLE_ACCOUNT, storeId: rows[0].id, method: 'sezzle', mode: 'test', publicKey: SEZZLE.publicKey, privateKey: SEZZLE.privateKey }]);
  } finally {
    await c.end();
  }
}
const gatewayAccounts = await gatewayAccountsJson();

// cwd is the git-ignored run dir so the API never picks up packages/api/.env (dotenv reads ./.env)
// and its relative ASSET_DIR / MAINTENANCE_FLAG_FILE / DOWNLOAD_DIR stay out of the checkout.
const child = spawn(process.execPath, ['--import', join(STOREFRONT_DIR, 'e2e', 'support', 'preload.mjs'), apiEntry], {
  cwd: RUN_DIR,
  env: {
    ...baseEnv,
    DATABASE_URL: DB_APP_URL,
    // The gateway seam (see preload.mjs). SR_E2E_PRELOAD is the explicit opt-in the preload demands under NODE_ENV=production.
    SR_E2E_PRELOAD: '1',
    E2E_MOCK_URL: MOCK_URL,
    E2E_HOOK_HOST: HOOK_SENTINEL.host,
    E2E_HOOK_PORT: String(HOOK_SENTINEL.port),
    E2E_JOB_INTERVAL_MS: '1000',
    // Real outbox + webhook + gateway-event workers, just fast. Gateway auto-recovery stays off (it would race specs
    // that deliberately leave an attempt pending).
    JOBS_ENABLED: '1',
    JOBS_GATEWAY_RECOVERY_APPLY: '0',
    // Real nodemailer path into the mock's SMTP sink.
    SMTP_ENABLED: 'true',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(SMTP_PORT),
    SMTP_FROM: 'shop@e2e.example.net',
    GATEWAY_ACCOUNTS_JSON: gatewayAccounts,
  },
  stdio: 'inherit',
});
const stop = (sig) => { if (!child.killed) child.kill(sig); };
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
child.on('exit', (code, signal) => process.exit(signal ? 0 : (code ?? 0)));
