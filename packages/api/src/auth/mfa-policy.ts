/**
 * Required-TOTP policy (P1b, security audit 2026-10-15).
 *
 * TOTP is REQUIRED for a human admin when any of:
 *   - env ADMIN_REQUIRE_TOTP = 'all';
 *   - env ADMIN_REQUIRE_TOTP = 'privileged' and the admin is an installation administrator or holds
 *     owner/manager on any store;
 *   - the admin holds owner/manager on a store whose config sets security.requireTotp = true
 *     (PATCH /v1/admin/settings/security, owner-only).
 * Agents (API-token identities) never have a second factor; the policy does not apply to them.
 *
 * A required-but-not-enrolled admin still signs in with the password, but the session can only enrol:
 * routes/admin-agent-guard.ts answers every other /v1/admin route with 403 TOTP_ENROLLMENT_REQUIRED.
 */
import { env } from '../env.js';
import type { AdminPrincipal } from './admin-session.js';

export type RequireTotpMode = 'off' | 'privileged' | 'all';
const PRIVILEGED = new Set(['owner', 'manager']);

export function totpRequiredFor(p: Pick<AdminPrincipal, 'kind' | 'isInstallationAdmin' | 'stores'>, mode: RequireTotpMode = env.ADMIN_REQUIRE_TOTP): boolean {
  if (p.kind !== 'human') return false;
  if (mode === 'all') return true;
  const privileged = p.stores.some((s) => PRIVILEGED.has(s.role));
  if (mode === 'privileged' && (p.isInstallationAdmin || privileged)) return true;
  return p.stores.some((s) => PRIVILEGED.has(s.role) && s.requireTotp === true);
}

/** Routes a required-but-not-enrolled session may still call: identify itself, enrol, re-verify, leave. */
export const ENROLLMENT_ALLOWED: ReadonlySet<string> = new Set([
  'GET /v1/admin/me',
  'GET /v1/admin/2fa',
  'POST /v1/admin/2fa/setup',
  'POST /v1/admin/2fa/enable',
  'POST /v1/admin/step-up',
  'POST /v1/admin/logout',
]);
