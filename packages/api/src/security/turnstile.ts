/**
 * Cross-lane seam for the launch-audit fixes (PAR-06).
 * Implemented by the par-customer lane; consumed wherever server-side
 * anti-bot verification is configured (contact form, auth paths).
 * Returns true when no secret is configured (feature disabled).
 *
 * Fail-closed contract: with a secret configured, ANY failure — missing
 * token, network error, non-2xx from siteverify, a malformed JSON body, or
 * `success !== true` — returns false. The only true path is Cloudflare
 * explicitly answering success for the presented token.
 */
const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
// Bounded wait: a slow/stuck siteverify must not hold the request open (or
// stall a queue of public-form submissions). 5s is generous for a same-
// continent Cloudflare call and short enough that a Down Cloudflare doesn't
// wedge the endpoint.
const VERIFY_TIMEOUT_MS = 5_000;

export async function verifyTurnstileToken(args: {
  secret: string | null | undefined;
  token: string | null | undefined;
  remoteIp?: string | null;
}): Promise<boolean> {
  const secret = args.secret?.trim();
  // Feature disabled: no secret configured → the check passes unconditionally.
  if (!secret) return true;
  const token = args.token?.trim();
  // Configured but the client presented nothing → fail closed.
  if (!token) return false;

  try {
    const body = new URLSearchParams({ secret, response: token });
    // remoteip is optional; Cloudflare uses it for extra abuse signal only.
    if (args.remoteIp && args.remoteIp !== 'unknown') body.set('remoteip', args.remoteIp);
    const res = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    if (!res.ok) return false; // siteverify itself is broken → fail closed
    const data = (await res.json()) as { success?: unknown };
    return data.success === true;
  } catch {
    // Network error / timeout / invalid JSON — all fail closed.
    return false;
  }
}
