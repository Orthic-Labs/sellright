/**
 * Short-lived, HMAC-signed download URLs. The license-gated
 * GET /v1/apps/{appKey}/downloads/{artifactKey} endpoint checks entitlement, then
 * hands the client one of these signed URLs instead of a permanent artifact path.
 * GET /v1/dl/{artifactKey} verifies the signature + expiry and streams the file —
 * the signature IS the capability, so a leaked link dies in minutes, not forever.
 *
 * The signature binds (storeId, artifactKey, exp) so a client can't swap the
 * store or the artifact, or extend the expiry.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../env.js';

export const DOWNLOAD_TTL_SEC = 900; // 15 minutes

export function downloadSigningConfigured(): boolean {
  return !!env.DOWNLOAD_URL_SECRET;
}

// ── pure core (no env — unit-testable with a literal secret) ──────────────────
export function computeSig(secret: string, storeId: string, artifactKey: string, exp: number): string {
  return createHmac('sha256', secret).update(`${storeId}:${artifactKey}:${exp}`).digest('base64url');
}

/** Pure verify: false on missing secret, expiry, non-numeric exp, or tamper.
 *  Constant-time signature compare. `now` is injectable for tests. */
export function verifyWithSecret(
  secret: string | undefined, storeId: string, artifactKey: string, exp: number, sig: string, now: number = Date.now(),
): boolean {
  if (!secret) return false;
  if (!Number.isFinite(exp) || exp * 1000 < now) return false;
  const a = Buffer.from(sig);
  const b = Buffer.from(computeSig(secret, storeId, artifactKey, exp));
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── env-bound shells (used by the routes) ─────────────────────────────────────
/** Build the relative signed path the client should GET to fetch the artifact.
 *  Throws if DOWNLOAD_URL_SECRET is unset — callers must gate on
 *  downloadSigningConfigured() and 503 rather than emit an unsigned link. */
export function signedDownloadPath(storeId: string, artifactKey: string, ttlSec = DOWNLOAD_TTL_SEC): string {
  if (!env.DOWNLOAD_URL_SECRET) throw new Error('DOWNLOAD_URL_SECRET is not configured');
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const q = new URLSearchParams({ store: storeId, exp: String(exp), sig: computeSig(env.DOWNLOAD_URL_SECRET, storeId, artifactKey, exp) });
  return `/v1/dl/${encodeURIComponent(artifactKey)}?${q.toString()}`;
}

export function verifyDownloadSig(storeId: string, artifactKey: string, exp: number, sig: string): boolean {
  return verifyWithSecret(env.DOWNLOAD_URL_SECRET, storeId, artifactKey, exp, sig);
}
