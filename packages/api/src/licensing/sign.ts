// v2 signed entitlement tokens — the server-side signer.
//
// The commerce backend is the entitlement AUTHORITY; this makes it also the
// SIGNER. On activate/refresh it mints a short-lived Ed25519-signed token whose
// claims (tier/features/device/exp) the *client* verifies locally — so
// enforcement can live in the app's native layer without trusting JS or phoning
// home on every action.
//
// Wire form:  base64url(canonicalPayloadJSON) + "." + base64url(ed25519 signature)
// The client verifier checks the SAME bytes — the field order in
// `canonicalPayload` below IS the canonical signing order and must stay
// identical on both sides.

import { createPrivateKey, sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { EntitlementStage, LicenseKind } from './license-lifecycle.js';
import { env } from '../env.js';
import { fingerprintPublicKey } from '../sdk/fingerprint.js';

export interface SignedPayload {
  /** Schema version. */
  v: number;
  /** License id. */
  id: string;
  /** appKey — the verifying app rejects tokens whose `app` != its own. */
  app: string;
  /** Authorization tier — tokens are only minted for paid, active licenses. */
  tier: string;
  /** Entitlement features. */
  features: string[];
  /** Device bound at activation. */
  device_id: string;
  /** Issued-at, unix seconds. */
  iat: number;
  /** Expiry, unix seconds. Short-lived; refresh re-signs. This is the revocation teeth. */
  exp: number;
  /** Additive lifecycle claims. Absent only on legacy v2 tokens. */
  license_kind?: LicenseKind;
  entitlement_stage?: EntitlementStage;
  license_issued_at?: number;
  confirmation_due_at?: number | null;
  /** Policy-supplied scope claim (entitlement-policy.ts `claims`). Omitted by the default policy. */
  entitlement_scope?: 'mobile' | 'full';
}

// ── FROZEN v:2 wire format (plan 3.7) ────────────────────────────────────────
// Canonical signing order. KEEP IDENTICAL to the shipped native verifiers'
// field order. The order below is pinned by `sign.golden.test.ts` and
// `test-vectors/signed-v2.golden.json`; any change fails CI. Optional claims
// are omitted (never `null`-filled) when absent, so a token minted under the
// default policy is byte-identical to every token minted before the policy
// seam existed. New claims may only be APPENDED at the end and only as
// optional; anything else is a new format version (below), never an edit.
export const V2_FIELD_ORDER = Object.freeze([
  'v', 'id', 'app', 'tier', 'features', 'device_id', 'iat', 'exp',
  'license_kind', 'entitlement_stage', 'license_issued_at', 'confirmation_due_at',
  'entitlement_scope',
] as const);

// ── Capability-negotiated format versions ────────────────────────────────────
// v:2 is built in and can never be replaced. A future format registers itself
// here; it is only EVER emitted to a client that offered that version
// (`x-entitlement-versions` request header, parsed by `parseOfferedVersions`),
// so clients that predate it keep receiving v:2 tokens their verifiers accept.
export interface SignedFormat {
  v: number;
  /** Canonical signing order for this version. */
  fieldOrder: readonly string[];
  /** Extra claims this format adds on top of the v:2 claim set. */
  extraClaims?(e: EntitlementInput): Record<string, unknown>;
}

const formats = new Map<number, SignedFormat>([[2, { v: 2, fieldOrder: V2_FIELD_ORDER }]]);

export function registerSignedFormat(format: SignedFormat): void {
  if (!Number.isInteger(format.v) || format.v <= 2) throw new Error('signed format version must be an integer > 2 (v:2 is frozen)');
  if (formats.has(format.v)) throw new Error(`signed format v:${format.v} is already registered`);
  if (new Set(format.fieldOrder).size !== format.fieldOrder.length) throw new Error('signed format fieldOrder has duplicates');
  // A client must never be able to pick a weaker format by offering it: every
  // v:2 claim (incl. entitlement_scope) must be carried by a negotiated format.
  const missing = V2_FIELD_ORDER.filter((k) => !format.fieldOrder.includes(k));
  if (missing.length) throw new Error(`signed format v:${format.v} must carry every v:2 claim; missing: ${missing.join(', ')}`);
  formats.set(format.v, { ...format, fieldOrder: Object.freeze([...format.fieldOrder]) });
}

/** Test/deploy seam: drop every registered format except the built-in v:2. */
export function resetSignedFormatsForTest(): void {
  for (const v of [...formats.keys()]) if (v !== 2) formats.delete(v);
}

export function supportedSignedVersions(): number[] {
  return [...formats.keys()].sort((a, b) => a - b);
}

/** Parse the `x-entitlement-versions` header ("2,3") into the offered list; undefined when absent/garbage. */
export function parseOfferedVersions(header: string | null | undefined): number[] | undefined {
  if (!header) return undefined;
  const out = header.split(',').map((p) => p.trim()).filter((p) => /^\d{1,6}$/.test(p)).map(Number);
  return out.length ? out : undefined;
}

/** Highest version both sides support. No offer, or no overlap => 2 (the frozen default). */
export function negotiateSignedVersion(offered?: readonly number[] | null): number {
  if (!offered?.length) return 2;
  let best = 2;
  for (const v of offered) if (formats.has(v) && v > best) best = v;
  return best;
}

/** The exact compact-JSON bytes that get signed (fixed field order, no whitespace). */
export function canonicalPayload(p: SignedPayload): string {
  const order = formats.get(p.v)?.fieldOrder;
  if (!order) throw new Error(`unsupported signed token version v:${p.v}`);
  const src = p as unknown as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const k of order) ordered[k] = src[k];
  return JSON.stringify(ordered);
}

const b64url = (b: Buffer) => b.toString('base64url');

/** Sign a payload with an Ed25519 private key → the compact token string. */
export function signToken(p: SignedPayload, privateKey: KeyObject): string {
  const msg = Buffer.from(canonicalPayload(p), 'utf8');
  const sig = edSign(null, msg, privateKey); // Ed25519: algorithm arg must be null
  return `${b64url(msg)}.${b64url(sig)}`;
}

/** Sanity verification. The REAL gate is the app's native verifier; this exists
 *  for tests + an optional server self-check. Returns the payload or null. */
export function verifyToken(token: string, publicKey: KeyObject): SignedPayload | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const msg = Buffer.from(token.slice(0, dot), 'base64url');
  const sig = Buffer.from(token.slice(dot + 1), 'base64url');
  if (!edVerify(null, msg, publicKey, sig)) return null;
  try {
    return JSON.parse(msg.toString('utf8')) as SignedPayload;
  } catch {
    return null;
  }
}

// ── env-backed signer used by activate/refresh ───────────────────────────────
let cachedKey: KeyObject | null | undefined;
function signingKey(): KeyObject | null {
  if (cachedKey !== undefined) return cachedKey;
  // Two ways to provide the key, in priority order:
  //  1. LICENSE_SIGNING_KEY      — inline PKCS8 PEM (single-line ok; `\n` is unescaped).
  //  2. LICENSE_SIGNING_KEY_FILE — path to a .pem on the server (cleaner for a multiline
  //     PEM). The server reads its own key at runtime — never echoed, never sent to a client.
  let pem: string | null = null;
  const inline = process.env.LICENSE_SIGNING_KEY;
  const file = process.env.LICENSE_SIGNING_KEY_FILE;
  if (inline) {
    pem = inline.replace(/\\n/g, '\n');
  } else if (file) {
    try {
      pem = readFileSync(file, 'utf8');
    } catch {
      pem = null; // missing/unreadable -> no signer; paid activation/refresh fails closed with 503
    }
  }
  cachedKey = pem ? createPrivateKey(pem) : null;
  return cachedKey;
}

/** Non-secret identity of the configured signing key (sha256 of its public SPKI), or null when unset. */
export function signingPublicKeyFingerprint(): { set: boolean; fingerprint: string | null } {
  let key: KeyObject | null;
  try { key = signingKey(); } catch { return { set: true, fingerprint: null }; }
  return fingerprintPublicKey(key);
}

export interface EntitlementInput {
  licenseId: string;
  app: string;
  tier: string;
  features: string[];
  deviceId: string;
  /** Token lifetime; defaults to 30d. Shorter = faster revocation, less offline grace. */
  ttlSeconds?: number;
  /** Hard ceiling for `exp` (unix seconds) — the license's own `expires_at`. Caps the
   *  rolling TTL so a time-limited license (e.g. a 14-day trial) can't mint a 30-day
   *  offline token that outlives it: the client gate honors the token's `exp`, so
   *  without this clamp an offline trial would keep its tier ~30 days past expiry.
   *  Null/omitted (a perpetual license) keeps the full rolling TTL. */
  expiresAtUnix?: number | null;
  /** Exact server-planned token boundary. Used for fixed provisional/final lifecycle. */
  tokenExpiresAtUnix?: number;
  licenseKind?: LicenseKind;
  entitlementStage?: EntitlementStage;
  licenseIssuedAtUnix?: number;
  confirmationDueAtUnix?: number | null;
  /** Policy claim (entitlement-policy.ts). Omitted => claim absent => default-policy bytes. */
  entitlementScope?: 'mobile' | 'full';
  /** Format versions the client offered (capability negotiation). Omitted => v:2. */
  offeredVersions?: readonly number[] | null;
}

// SEC: default lowered from 30d to 7d to tighten the offline-revocation window
// on a compromised or refunded license; override via ENTITLEMENT_TTL_SECONDS
// when a deployment genuinely needs a longer offline grace period.
const defaultTtlSeconds = (): number => env.ENTITLEMENT_TTL_SECONDS ?? 7 * 86_400;

/** Mint a signed token for an active entitlement. Returns null when signing isn't
 *  configured (no `LICENSE_SIGNING_KEY`), so endpoints degrade gracefully before the
 *  key is provisioned — the response simply omits `signedToken` and old clients are
 *  unaffected. */
export function signEntitlement(e: EntitlementInput, now: number = Date.now()): string | null {
  const key = signingKey();
  if (!key) return null;
  const iat = Math.floor(now / 1000);
  const rollingExp = iat + (e.ttlSeconds ?? defaultTtlSeconds());
  // Never let the offline token outlive the license's hard expiry.
  const exp = e.tokenExpiresAtUnix
    ?? (e.expiresAtUnix != null ? Math.min(rollingExp, e.expiresAtUnix) : rollingExp);
  const v = negotiateSignedVersion(e.offeredVersions);
  // Format extras go FIRST so they can add claims but never override a v:2 one.
  const extras = Object.fromEntries(
    Object.entries(v > 2 ? formats.get(v)?.extraClaims?.(e) ?? {} : {}).filter(([k]) => !(V2_FIELD_ORDER as readonly string[]).includes(k)),
  );
  const payload: SignedPayload = {
    ...(extras as Partial<SignedPayload>),
    v,
    id: e.licenseId,
    app: e.app,
    tier: e.tier,
    features: e.features,
    device_id: e.deviceId,
    iat,
    exp,
    ...(e.licenseKind ? { license_kind: e.licenseKind } : {}),
    ...(e.entitlementStage ? { entitlement_stage: e.entitlementStage } : {}),
    ...(e.licenseIssuedAtUnix != null ? { license_issued_at: e.licenseIssuedAtUnix } : {}),
    ...(e.confirmationDueAtUnix !== undefined ? { confirmation_due_at: e.confirmationDueAtUnix } : {}),
    ...(e.entitlementScope ? { entitlement_scope: e.entitlementScope } : {}),
  };
  return signToken(payload, key);
}

/** Test seam: reset the memoized key (so a test can set/unset the env). */
export function _resetSigningKeyCache(): void {
  cachedKey = undefined;
}

// ── device-lease envelope signature ──────────────────────────────────────────
// The renewable device lease (`{ leaseId, deviceIdHash, pool, entitlement,
// issuedAt, expiresAt, graceSeconds, generation }`) is a SEPARATE envelope from
// the v2 entitlement token above — `entitlement` nests a normal
// signEntitlement() token, and the envelope itself is additionally signed with
// the same Ed25519 key so a client (or a native lease cache) can verify the
// lease metadata itself was not tampered with, without re-parsing the nested
// entitlement token. Reuses the same env-provisioned signing key — deliberately
// NOT a new key, so lease signing degrades the same way entitlement signing
// does (null when unconfigured; callers fail closed).
export function signLeaseEnvelope(canonicalJson: string): string | null {
  const key = signingKey();
  if (!key) return null;
  const sig = edSign(null, Buffer.from(canonicalJson, 'utf8'), key);
  return b64url(sig);
}

export function verifyLeaseEnvelope(canonicalJson: string, signatureB64url: string, publicKey: KeyObject): boolean {
  try {
    return edVerify(null, Buffer.from(canonicalJson, 'utf8'), publicKey, Buffer.from(signatureB64url, 'base64url'));
  } catch {
    return false;
  }
}
