// Shared constants for the admin e2e harness. Plain ESM so both Node (start-api.mjs,
// run directly) and Playwright's TS loader (config, specs) can import it.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ADMIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const API_DIR = resolve(ADMIN_DIR, '..', 'api');
export const RUN_DIR = join(ADMIN_DIR, 'e2e', '.run');
export const AUTH_FILE = join(RUN_DIR, 'owner.storage.json');

// Ports are deliberately NOT the dev API (3300) or the storefront e2e (4398).
export const API_PORT = Number(process.env.E2E_API_PORT ?? 3399);
export const ADMIN_PORT = Number(process.env.E2E_ADMIN_PORT ?? 4399);
export const API_URL = `http://127.0.0.1:${API_PORT}`;
export const ADMIN_URL = `http://127.0.0.1:${ADMIN_PORT}`;

export const DB_NAME = 'sellright_admin_e2e';
// Maintenance connection (used only to DROP/CREATE the throwaway database).
export const DB_ADMIN_URL = process.env.E2E_DB_ADMIN_URL ?? 'postgres://sellright@127.0.0.1:5433/postgres';
// Owner connection (migrate + bootstrap, then the API too unless an app role is given).
export const DB_OWNER_URL = process.env.E2E_DATABASE_URL ?? `postgres://sellright@127.0.0.1:5433/${DB_NAME}`;
// Role the API serves requests as. CI passes a NOSUPERUSER NOBYPASSRLS role here.
export const DB_APP_URL = process.env.E2E_APP_DATABASE_URL ?? DB_OWNER_URL;

export const STORE_SLUG = 'e2e';
export const OWNER_EMAIL = 'owner@e2e.example.net';
export const OWNER_PASSWORD = 'e2e-owner-password-12345';

// Environments this suite must never touch.
const FORBIDDEN_DB = ['sellright_dev', 'dd_sellright', 'rh_sellright', 'sellright_demo', 'rightsites'];

export function assertSafeTargets() {
  for (const raw of [DB_OWNER_URL, DB_APP_URL]) {
    const u = new URL(raw);
    const name = decodeURIComponent(u.pathname.slice(1));
    if (!/_e2e$/.test(name) || FORBIDDEN_DB.some((f) => name === f || name.startsWith(`${f}_`))) {
      throw new Error(`refusing to run admin e2e against database "${name}" (must end in _e2e and not be a dev/prod DB)`);
    }
  }
  if (API_PORT === 3300) throw new Error('refusing to use the dev API port 3300');
}
