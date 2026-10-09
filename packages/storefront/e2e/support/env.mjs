// Shared constants for the storefront e2e harness. Plain ESM so Node (start-api.mjs, mock-gateways.mjs, preload.mjs,
// run directly) and Playwright's TS loader (config, specs) can import the same values.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STOREFRONT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const API_DIR = resolve(STOREFRONT_DIR, '..', 'api');
export const RUN_DIR = join(STOREFRONT_DIR, 'e2e', '.run');

/** True when the suite was pointed at an API somebody else runs (PLAYWRIGHT_API_URL): no fresh DB, no mock gateways. */
export const EXTERNAL_API = !!process.env.PLAYWRIGHT_API_URL;

// Ports are deliberately NOT the dev API (3300), the admin e2e (3399/4399) or any production port.
export const API_PORT = Number(process.env.E2E_API_PORT ?? 3398);
export const STORE_PORT = Number(process.env.PLAYWRIGHT_PORT ?? 4398);
export const MOCK_PORT = Number(process.env.E2E_MOCK_PORT ?? 3397);
export const SMTP_PORT = Number(process.env.E2E_SMTP_PORT ?? 3396);
export const API_URL = process.env.PLAYWRIGHT_API_URL ?? `http://127.0.0.1:${API_PORT}`;
export const STORE_URL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${STORE_PORT}`;
export const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}`;

export const DB_NAME = 'sellright_storefront_e2e';
// Maintenance connection (used only to DROP/CREATE the throwaway database).
export const DB_ADMIN_URL = process.env.E2E_DB_ADMIN_URL ?? 'postgres://sellright@127.0.0.1:5433/postgres';
// Owner connection (migrate + bootstrap + seed + read-only verification queries).
export const DB_OWNER_URL = process.env.E2E_DATABASE_URL ?? `postgres://sellright@127.0.0.1:5433/${DB_NAME}`;
// Role the API serves requests as. CI passes a NOSUPERUSER NOBYPASSRLS role here.
export const DB_APP_URL = process.env.E2E_APP_DATABASE_URL ?? DB_OWNER_URL;

export const STORE_SLUG = 'e2e';
export const OWNER_EMAIL = 'owner@e2e.example.net';
export const OWNER_PASSWORD = 'e2e-owner-password-12345';

// Fake credentials handed to the mock gateways. They never leave this machine: the API process is started with a
// preload (support/preload.mjs) that rewrites every sandbox gateway host to the local mock and refuses any other
// outbound fetch.
export const NMI = { securityKey: 'e2e-nmi-security-key', tokenizationKey: 'e2e-nmi-tokenization-key', privateKey: 'e2e-nmi-webhook-secret' };
export const SEZZLE = { publicKey: 'e2e-sezzle-public-key', privateKey: 'e2e-sezzle-private-key' };
/** accountId of the server-configured Sezzle account (GATEWAY_ACCOUNTS_JSON) — also the segment of the webhook URL. */
export const SEZZLE_ACCOUNT = 'e2e-sezzle';

/** An address that passes the API's SSRF guard (it is public) but that the API preload reroutes to the mock's
 *  webhook receiver. Nothing is ever sent to it for real. */
export const HOOK_SENTINEL = { host: '45.45.45.45', port: 8045 };
export const HOOK_URL = `http://${HOOK_SENTINEL.host}:${HOOK_SENTINEL.port}/hook`;

// Environments this suite must never touch.
const FORBIDDEN_DB = ['sellright_dev', 'dd_sellright', 'rh_sellright', 'sellright_demo', 'rightsites'];
const FORBIDDEN_PORTS = [3300];

export function assertSafeTargets() {
  if (EXTERNAL_API) return; // nothing destructive happens against an external API
  for (const raw of [DB_OWNER_URL, DB_APP_URL]) {
    const u = new URL(raw);
    const name = decodeURIComponent(u.pathname.slice(1));
    if (!/_e2e$/.test(name) || FORBIDDEN_DB.some((f) => name === f || name.startsWith(`${f}_`))) {
      throw new Error(`refusing to run storefront e2e against database "${name}" (must end in _e2e and not be a dev/prod DB)`);
    }
  }
  for (const port of [API_PORT, MOCK_PORT, SMTP_PORT, STORE_PORT]) {
    if (FORBIDDEN_PORTS.includes(port)) throw new Error(`refusing to use port ${port}`);
  }
}
