/**
 * Maintenance mode (WS-E, decision 1.11 step 1).
 *
 * A single fact — "is the appliance mid-update?" — shared by three
 * consumers that otherwise have no channel between them: the HTTP API
 * (must 503 writes), the in-process job scheduler (must pause), and the
 * storefront (must show "back soon"). The storefront has no direct disk or
 * DB access (WS-C: it only calls this API), so the flag can't live purely in
 * the storefront process — it lives here as a file on a volume that survives
 * an `api` container restart (a bare mid-request-restart during `docker
 * compose up -d api` must not silently drop back into "open"), and the
 * storefront learns it by polling GET /v1/maintenance (see app.ts).
 *
 * File, not a DB row: the update sequence flips this flag BEFORE it knows
 * the database is even reachable (maintenance is step 1, backup is step 2),
 * and must be able to flip it back off in the rollback path even if the
 * migration step failed partway. Tying it to a DB write would make the flag
 * itself depend on the thing being protected.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { env } from './env.js';

export function maintenanceFlagPath(): string {
  return env.MAINTENANCE_FLAG_FILE;
}

export function isMaintenanceOn(): boolean {
  return existsSync(maintenanceFlagPath());
}

/** Reason string is informational only (surfaced by GET /v1/maintenance for the storefront banner). */
export function setMaintenance(on: boolean, reason?: string): void {
  const path = maintenanceFlagPath();
  if (on) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ since: new Date().toISOString(), reason: reason ?? 'update' }));
  } else {
    rmSync(path, { force: true });
  }
}

export function maintenanceInfo(): { maintenance: boolean; since?: string; reason?: string } {
  const path = maintenanceFlagPath();
  if (!existsSync(path)) return { maintenance: false };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { since?: string; reason?: string };
    return { maintenance: true, since: raw.since, reason: raw.reason };
  } catch {
    // Flag file exists but isn't parseable (e.g. touched by hand) — still
    // fail closed (maintenance on), just without the extra detail.
    return { maintenance: true };
  }
}
