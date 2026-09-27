/**
 * WS-A (one-click install plan §1.7): "Test connection" checks for owner-
 * entered payment credentials. Each check is a HARMLESS, read-only call —
 * never a charge, refund, or anything that moves money — and never logs the
 * credential itself. Uses the same GatewayFetch injection pattern as
 * nmi.ts/sezzle.ts so tests run with a mocked transport, no real network call.
 */
import { boundedGatewayResponse, type GatewayFetch } from './gateway-account.js';

export interface VerifyResult {
  ok: boolean;
  error?: string;
}

// ── NMI: harmless query ──────────────────────────────────────────────────
// The reporting API (query.php) accepts a security_key and a narrow,
// zero-result-safe date window. An invalid/revoked key returns an
// authentication failure in the XML root; a valid key returns a well-formed
// <nm_response> even with zero transactions in range.
export async function verifyNmiKey(
  securityKey: string,
  environment: 'sandbox' | 'production',
  transport: GatewayFetch = fetch,
): Promise<VerifyResult> {
  if (!securityKey) return { ok: false, error: 'Security key is required' };
  const base = environment === 'sandbox' ? 'https://sandbox.nmi.com' : 'https://secure.nmi.com';
  // A one-second window in the far past — always zero results, never exposes
  // real transaction data, and is cheap for NMI to answer either way.
  const body = new URLSearchParams({
    security_key: securityKey,
    start_date: '20000101000000', end_date: '20000101000001',
  });
  try {
    const response = await transport(base + '/api/query.php', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(), signal: AbortSignal.timeout(15_000), redirect: 'error',
    });
    const text = await boundedGatewayResponse(response);
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) return { ok: false, error: 'Invalid NMI response' };
    if (/<nm_response>/i.test(text) && !/authentication failed|invalid.*security.*key/i.test(text)) {
      return { ok: true };
    }
    return { ok: false, error: 'NMI rejected the security key' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'NMI verification failed' };
  }
}

// ── Sezzle: request an auth token ────────────────────────────────────────
export async function verifySezzleKeys(
  publicKey: string,
  privateKey: string,
  mode: 'sandbox' | 'production',
  transport: GatewayFetch = fetch,
): Promise<VerifyResult> {
  if (!publicKey || !privateKey) return { ok: false, error: 'Public and private key are required' };
  const base = mode === 'sandbox' ? 'https://sandbox.gateway.sezzle.com' : 'https://gateway.sezzle.com';
  try {
    const response = await transport(base + '/v2/authentication', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ public_key: publicKey, private_key: privateKey }),
      signal: AbortSignal.timeout(15_000), redirect: 'error',
    });
    const text = await boundedGatewayResponse(response);
    const parsed = JSON.parse(text) as { token?: string };
    if (parsed.token) return { ok: true };
    return { ok: false, error: 'Sezzle rejected the public/private key pair' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Sezzle verification failed' };
  }
}

// ── Stripe: key shape + a cheap authenticated read ───────────────────────
// Injected client keeps this decoupled from the real `stripe` SDK type so
// tests don't need a live/sandbox key or network access.
export interface StripeVerifyClient {
  balance: { retrieve(): Promise<unknown> };
}

export async function verifyStripeKey(secretKey: string, mode: 'test' | 'live', client: StripeVerifyClient): Promise<VerifyResult> {
  if (!secretKey) return { ok: false, error: 'Secret key is required' };
  const expectedInfix = mode === 'live' ? '_live_' : '_test_';
  if (!secretKey.includes(expectedInfix)) {
    return { ok: false, error: `Key does not look like a Stripe ${mode} secret key` };
  }
  try {
    await client.balance.retrieve();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Stripe rejected the key' };
  }
}
