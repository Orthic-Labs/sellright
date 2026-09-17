// Sign in with Apple identity-token verification (ported upstream from
// RightSites — the verifier itself is unchanged; the accepted-audience list is
// now per-store config, not a suite constant).
//
// Verifies a client-supplied Apple `identityToken` (a JWT) against Apple's
// published JWKS (https://appleid.apple.com/auth/keys) server-side — signature,
// issuer, audience, and expiry — the same shape as verifyGoogleIdToken in
// auth.ts, so the two OAuth-style linking flows read the same way. No external
// JWT library dependency: RS256 verification is a handful of node:crypto calls.
import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { env } from '../env.js';
import { storeAuthConfig } from './session.js';

const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';
const APPLE_ISSUER = 'https://appleid.apple.com';
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000; // Apple's keys rotate rarely; 1h cache is safe.

interface AppleJwk { kty: string; kid: string; use: string; alg: string; n: string; e: string }

let cachedJwks: { at: number; keys: AppleJwk[] } | null = null;

async function fetchAppleJwks(): Promise<AppleJwk[]> {
  if (cachedJwks && Date.now() - cachedJwks.at < JWKS_CACHE_TTL_MS) return cachedJwks.keys;
  const res = await fetch(APPLE_JWKS_URL);
  if (!res.ok) throw new Error(`apple jwks fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys: AppleJwk[] };
  cachedJwks = { at: Date.now(), keys: body.keys };
  return body.keys;
}

function b64urlToBuf(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

function keyFromJwk(jwk: AppleJwk): KeyObject {
  return createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' });
}

export interface AppleIdentity {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  isPrivateRelay: boolean;
}

/**
 * Accepted Sign-in-with-Apple audiences for a store, most specific wins:
 * store.config.auth.appleClientId (string or string[]) — the native app's
 * bundle id and/or a web Services ID — else the APPLE_CLIENT_IDS env
 * (comma-separated). Empty = not configured → the endpoint 409s.
 * The audience list is server-side config ONLY — a client-supplied bundle id
 * is never trusted (anyone could mint a JWT claiming any aud).
 */
export function appleClientIds(config: unknown): string[] {
  const auth = storeAuthConfig(config);
  const v = auth.appleClientId;
  const fromConfig = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
  const source = fromConfig.length ? fromConfig : (env.APPLE_CLIENT_IDS ?? '').split(',');
  return source.map((x) => String(x).trim()).filter(Boolean);
}

/** Verify an Apple identity token. Returns null on any failure (bad signature,
 *  wrong issuer/audience, expired, malformed) — callers treat null uniformly
 *  as "reject the sign-in", never distinguishing failure reasons to the client
 *  (avoids turning this into an oracle). */
export async function verifyAppleIdentityToken(identityToken: string, expectedAudience: string): Promise<AppleIdentity | null> {
  const parts = identityToken.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];
  let header: { kid?: string; alg?: string };
  let payload: {
    iss?: string; aud?: string; sub?: string; exp?: number; iat?: number;
    email?: string; email_verified?: string | boolean; is_private_email?: string | boolean;
  };
  try {
    header = JSON.parse(b64urlToBuf(headerB64).toString('utf8'));
    payload = JSON.parse(b64urlToBuf(payloadB64).toString('utf8'));
  } catch {
    return null;
  }
  if (header.alg !== 'RS256' || !header.kid) return null;
  if (payload.iss !== APPLE_ISSUER) return null;
  if (payload.aud !== expectedAudience) return null;
  if (!payload.sub) return null;
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= now) return null;

  let jwks: AppleJwk[];
  try {
    jwks = await fetchAppleJwks();
  } catch {
    return null;
  }
  const jwk = jwks.find((k) => k.kid === header.kid && k.use === 'sig');
  if (!jwk) return null;

  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
  const sig = b64urlToBuf(sigB64);
  let ok: boolean;
  try {
    ok = cryptoVerify('RSA-SHA256', signingInput, keyFromJwk(jwk), sig);
  } catch {
    return null;
  }
  if (!ok) return null;

  const emailVerified = payload.email_verified === true || payload.email_verified === 'true';
  return {
    sub: payload.sub,
    email: payload.email ?? null,
    emailVerified,
    isPrivateRelay: payload.is_private_email === true || payload.is_private_email === 'true',
  };
}

/** Test seam: reset the memoized JWKS (so a test can mock fetch and re-fetch). */
export function _resetAppleJwksCache(): void {
  cachedJwks = null;
}
