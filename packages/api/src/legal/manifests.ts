/**
 * Store-configured legal manifests — the generic-engine counterpart of
 * RightSites' committed suite manifests (which stay downstream). A store opts
 * a product into checkout legal acceptance by configuring:
 *
 *   store.config.legalManifests: { [appKey]: LegalManifest }
 *
 * Each entry is a full `@rightkit/legal` LegalManifest (documents'
 * role/id/version/sha256/publicUrl/treatment), validated by
 * `assertLegalManifest` on first use. This is the ONLY source checkout trusts:
 * the client echoes document claims, and every field is verified against the
 * configured manifest — client-supplied hashes are never trusted.
 *
 * Fail-closed on misconfiguration: a malformed entry or an appKey mismatch
 * throws (surfacing as a server error, not a shopper 4xx) rather than silently
 * selling licensed software with no verifiable acceptance. An absent entry is
 * NOT an error — it means the product hasn't opted in and requires nothing.
 */
import { assertLegalManifest, type LegalManifest } from "@rightkit/legal";

// Per config-object validation cache: store.config is a fresh JSON parse per
// request, so WeakMap keyed on the legalManifests record validates each entry
// at most once per resolution without pinning stale config forever.
const VALIDATED = new WeakMap<object, Map<string, LegalManifest | null>>();

/**
 * Returns the load-validated legal manifest configured for `appKey` in this
 * store, or null when none is configured (product not opted in).
 * Throws when the configured entry fails `assertLegalManifest` or declares a
 * different appKey than the slot it is stored under.
 */
export function legalManifestForApp(storeConfig: unknown, appKey: string): LegalManifest | null {
  const raw = (storeConfig as { legalManifests?: unknown } | null | undefined)?.legalManifests;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  let cache = VALIDATED.get(raw);
  if (!cache) {
    cache = new Map();
    VALIDATED.set(raw, cache);
  }
  if (cache.has(appKey)) return cache.get(appKey)!;

  const candidate = (raw as Record<string, unknown>)[appKey];
  if (candidate == null) {
    cache.set(appKey, null);
    return null;
  }
  const manifest = assertLegalManifest(candidate as LegalManifest);
  if (manifest.appKey !== appKey) {
    throw new Error(`legal manifest for "${appKey}" declares mismatched appKey "${manifest.appKey}"`);
  }
  cache.set(appKey, manifest);
  return manifest;
}
