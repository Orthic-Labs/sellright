/**
 * Short-lived, HMAC-signed download URLs. The license-gated
 * GET /v1/apps/{appKey}/downloads/{artifactKey} endpoint checks entitlement, then
 * hands the client one of these signed URLs instead of a permanent artifact path.
 * GET /v1/dl/{artifactKey} verifies the signature + expiry and streams the file —
 * the signature IS the capability, so a leaked link dies in minutes, not forever.
 *
 * The signature binds (storeId, artifactKey, releaseId, exp) so a client can't swap the
 * store, the artifact or the release, or extend the expiry. A link issued for one release
 * therefore never resolves to a newer release that reuses the same artifactKey.
 *
 * Links issued before releases were bound (no release id, signature over storeId:artifactKey:exp) still verify
 * until they expire (DOWNLOAD_TTL_SEC); the /v1/dl handler accepts those only while exactly one release carries
 * the artifactKey.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../env.js';

export const DOWNLOAD_TTL_SEC = 900; // 15 minutes

export function downloadSigningConfigured(): boolean {
  return !!env.DOWNLOAD_URL_SECRET;
}

// ── pure core (no env — unit-testable with a literal secret) ──────────────────
export function computeSig(secret: string, storeId: string, artifactKey: string, exp: number, releaseId?: string): string {
  // The release-bound payload carries a version prefix so it can never equal a legacy payload for another artifactKey.
  const payload = releaseId ? `v2|${storeId}|${artifactKey}|${releaseId}|${exp}` : `${storeId}:${artifactKey}:${exp}`;
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** Pure verify: false on missing secret, expiry, non-numeric exp, or tamper.
 *  Constant-time signature compare. `now` is injectable for tests. */
export function verifyWithSecret(
  secret: string | undefined, storeId: string, artifactKey: string, exp: number, sig: string, now: number = Date.now(), releaseId?: string,
): boolean {
  if (!secret) return false;
  if (!Number.isFinite(exp) || exp * 1000 < now) return false;
  const a = Buffer.from(sig);
  const b = Buffer.from(computeSig(secret, storeId, artifactKey, exp, releaseId));
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── env-bound shells (used by the routes) ─────────────────────────────────────
/** Build the relative signed path the client should GET to fetch the artifact.
 *  Throws if DOWNLOAD_URL_SECRET is unset — callers must gate on
 *  downloadSigningConfigured() and 503 rather than emit an unsigned link. */
export function signedDownloadPath(storeId: string, artifactKey: string, ttlSec = DOWNLOAD_TTL_SEC, releaseId?: string): string {
  if (!env.DOWNLOAD_URL_SECRET) throw new Error('DOWNLOAD_URL_SECRET is not configured');
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const q = new URLSearchParams({ store: storeId, exp: String(exp), sig: computeSig(env.DOWNLOAD_URL_SECRET, storeId, artifactKey, exp, releaseId) });
  if (releaseId) q.set('rel', releaseId);
  return `/v1/dl/${encodeURIComponent(artifactKey)}?${q.toString()}`;
}

export function verifyDownloadSig(storeId: string, artifactKey: string, exp: number, sig: string, releaseId?: string): boolean {
  return verifyWithSecret(env.DOWNLOAD_URL_SECRET, storeId, artifactKey, exp, sig, Date.now(), releaseId);
}
