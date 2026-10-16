// Shared constants for the storefront e2e harness. Plain ESM so Node (start-api.mjs, mock-gateways.mjs, preload.mjs,
// run directly) and Playwright's TS loader (config, specs) can import the same values.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OWN_SUPPORT_DIR = dirname(fileURLToPath(import.meta.url));

export const STOREFRONT_DIR = resolve(OWN_SUPPORT_DIR, '..', '..');
// Each of these can be redirected so the suite runs from a read-only pinned checkout (sellright-release.sh makes every
// checkout file read-only) or against a brand scratch tree: nothing the harness writes may land inside a checkout.
//   E2E_API_DIR      built API (packages/api with dist/); default: the sibling packages/api of this checkout
//   E2E_SUPPORT_DIR  directory holding preload.mjs / mock-gateways.mjs / start-api.mjs; default: this directory
//   E2E_RUN_DIR      writable scratch + cwd for the API/mock subprocesses, run logs; default: e2e/.run (git-ignored)
export const API_DIR = process.env.E2E_API_DIR ? resolve(process.env.E2E_API_DIR) : resolve(STOREFRONT_DIR, '..', 'api');
export const SUPPORT_DIR = process.env.E2E_SUPPORT_DIR ? resolve(process.env.E2E_SUPPORT_DIR) : OWN_SUPPORT_DIR;
export const RUN_DIR = process.env.E2E_RUN_DIR ? resolve(process.env.E2E_RUN_DIR) : join(STOREFRONT_DIR, 'e2e', '.run');
/** Catalog manifest output directory. Unset (default) = publisher off and storefront reads the live API; set =
 *  the real publisher writes generations here and the storefront server reads the same directory. */
export const CATALOG_DIR = process.env.E2E_CATALOG_DIR ? resolve(process.env.E2E_CATALOG_DIR) : undefined;

/** True when the suite was pointed at an API somebody else runs (PLAYWRIGHT_API_URL): no fresh DB, no mock gateways. */
export const EXTERNAL_API = !!process.env.PLAYWRIGHT_API_URL;

// Ports are deliberately NOT the dev API (3300), the admin e2e (3399/4399) or any production port.
export const API_PORT = Number(process.env.E2E_API_PORT ?? 3398);
export const STORE_PORT = Number(process.env.PLAYWRIGHT_PORT ?? 4398);
export const MOCK_PORT = Number(process.env.E2E_MOCK_PORT ?? 3397);
export const TAP_PORT = Number(process.env.E2E_TAP_PORT ?? 3395);
export const SMTP_PORT = Number(process.env.E2E_SMTP_PORT ?? 3396);
export const API_URL = process.env.PLAYWRIGHT_API_URL ?? `http://127.0.0.1:${API_PORT}`;
export const STORE_URL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${STORE_PORT}`;
export const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}`;

/** API tap (support/api-tap.mjs): E2E_API_TAP=1 puts a recording reverse proxy between BOTH the storefront server and
 *  the browser-side /v1 proxy (fixtures.ts) and the real API. Admin/setup calls (AdminApi) keep using API_URL, so the
 *  recorded log holds only what the storefront itself asked for. Off by default. */
export const API_TAP = process.env.E2E_API_TAP === '1';
export const TAP_URL = `http://127.0.0.1:${TAP_PORT}`;
/** What the storefront (server side and browser proxy) is told its API is. */
export const SHOP_API_URL = API_TAP ? TAP_URL : API_URL;
export const API_LOG_FILE = join(RUN_DIR, 'api-requests.jsonl');
export const FS_LOG_FILE = join(RUN_DIR, 'fs-reads.jsonl');

export const DB_NAME = process.env.E2E_DB_NAME ?? 'sellright_storefront_e2e';
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
// Test-mode-shaped fake Stripe credentials (the API requires sk_/pk_ prefixes that embed the mode). Seeded only when
// E2E_STRIPE=1 (see global-setup.ts): enabling Stripe changes the checkout the existing NMI/Sezzle specs drive.
export const STRIPE = { publishableKey: 'pk_test_e2e_seam', secretKey: 'sk_test_e2e_seam', webhookSecret: 'whsec_e2e_seam_secret' };
export const STRIPE_ENABLED = process.env.E2E_STRIPE === '1';
export const SEZZLE = { publicKey: 'e2e-sezzle-public-key', privateKey: 'e2e-sezzle-private-key' };
/** accountId of the admin-saved (encrypted store_secret) Sezzle account — the API's DB_ACCOUNT_ID — also the segment of the webhook URL. */
export const SEZZLE_ACCOUNT = 'db';

/** An address that passes the API's SSRF guard (it is public) but that the API preload reroutes to the mock's
 *  webhook receiver. Nothing is ever sent to it for real. */
export const HOOK_SENTINEL = { host: '45.45.45.45', port: 8045 };
export const HOOK_URL = `http://${HOOK_SENTINEL.host}:${HOOK_SENTINEL.port}/hook`;

// Environments this suite must never touch.
const FORBIDDEN_DB = ['sellright_dev', 'dd_sellright', 'rh_sellright', 'sellright_demo', 'rightsites'];
const FORBIDDEN_PORTS = [3300];

export function assertSafeTargets() {
  if (EXTERNAL_API) return; // nothing destructive happens against an external API
  const urlName = (raw) => decodeURIComponent(new URL(raw).pathname.slice(1));
  // start-api.mjs DROPs and CREATEs DB_NAME, so the connection URLs must name exactly that database.
  for (const name of [DB_NAME, urlName(DB_OWNER_URL), urlName(DB_APP_URL)]) {
    if (!/_e2e$/.test(name) || FORBIDDEN_DB.some((f) => name === f || name.startsWith(`${f}_`))) {
      throw new Error(`refusing to run storefront e2e against database "${name}" (must end in _e2e and not be a dev/prod DB)`);
    }
    if (name !== DB_NAME) throw new Error(`refusing to run: connection URL names database "${name}" but E2E_DB_NAME/DB_NAME is "${DB_NAME}"`);
  }
  for (const port of [API_PORT, MOCK_PORT, SMTP_PORT, STORE_PORT, TAP_PORT]) {
    if (FORBIDDEN_PORTS.includes(port)) throw new Error(`refusing to use port ${port}`);
  }
}
