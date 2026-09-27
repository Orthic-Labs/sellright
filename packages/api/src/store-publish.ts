/**
 * Store publish state + private-preview gating (WS-C: runtime storefront
 * configuration; plan §1.9). A brand-new store is unpublished until the owner
 * completes onboarding, but every store migrated from before this field
 * existed must keep working exactly as it does today — hence the `?? true`
 * default in `isStorePublished`, never a stricter default.
 *
 * The preview token lets the owner (or anyone with the link) view an
 * unpublished store's storefront before it goes live. Only a SHA-256 hash of
 * the token is ever persisted in store.config — the plaintext token exists
 * only in the HTTP response the moment it is issued, mirroring the claim-token
 * pattern used for installation setup.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export interface StorePublishConfig {
  /** Absent (existing stores) or `true` → published. Only `false` gates the storefront. */
  published?: boolean;
  /** SHA-256 hex digest of the current preview token, or absent if none was issued. */
  previewTokenHash?: string;
}

/** Existing stores (config.published absent) must behave exactly as before
 *  this field was introduced — i.e. published. Only an explicit `false` gates. */
export function isStorePublished(config: unknown): boolean {
  const c = (config ?? {}) as StorePublishConfig;
  return c.published !== false;
}

/** 256 bits of randomness, URL-safe base64 — short enough to paste into a link. */
export function generatePreviewToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashPreviewToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time compare against the stored hash. Returns false (never throws)
 *  for a missing token, missing hash, or a length mismatch. */
export function verifyPreviewToken(config: unknown, suppliedToken: string | undefined | null): boolean {
  if (!suppliedToken) return false;
  const c = (config ?? {}) as StorePublishConfig;
  const storedHash = c.previewTokenHash;
  if (!storedHash) return false;
  const suppliedHash = hashPreviewToken(suppliedToken);
  const a = Buffer.from(storedHash, 'hex');
  const b = Buffer.from(suppliedHash, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** True when the request may see this store's storefront: published, or an
 *  unpublished store with a valid preview token attached to the request. */
export function canViewStorefront(config: unknown, suppliedToken: string | undefined | null): boolean {
  return isStorePublished(config) || verifyPreviewToken(config, suppliedToken);
}

/** Thrown by shop routes to 404 an unpublished store with no/invalid preview
 *  token — same shape as StoreSlugError/HostRoutingError so route error
 *  handling treats it identically (a real store must be indistinguishable
 *  from an unknown one to an outside observer). */
export class StoreNotPublishedError extends Error {
  readonly httpStatus = 404 as const;
  constructor(message = 'store not found') {
    super(message);
    this.name = 'StoreNotPublishedError';
  }
}
