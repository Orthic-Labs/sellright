import { normalizeEmail } from './email.js';

export type GoogleIdentity = {
  sub: string;
  email: string;
  emailVerified: boolean;
  /** Google Workspace hosted domain (`hd` claim), lower-cased; null for consumer accounts. */
  hostedDomain: string | null;
  firstName: string | null;
  lastName: string | null;
};

const GOOGLE_MAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/** Verify a Google Identity Services ID token via Google's tokeninfo endpoint —
 *  validates signature + expiry server-side; we additionally check `aud`. */
export async function verifyGoogleIdToken(credential: string, clientId: string): Promise<GoogleIdentity | null> {
  const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
  if (!res.ok) return null;
  const p = (await res.json()) as { aud?: string; sub?: string; email?: string; email_verified?: string | boolean; hd?: unknown; given_name?: string; family_name?: string };
  if (!p.sub || !p.email || p.aud !== clientId) return null;
  const emailVerified = p.email_verified === true || p.email_verified === 'true';
  const hostedDomain = typeof p.hd === 'string' && p.hd.trim() ? p.hd.trim().toLowerCase() : null;
  return { sub: p.sub, email: normalizeEmail(p.email), emailVerified, hostedDomain, firstName: p.given_name ?? null, lastName: p.family_name ?? null };
}

/** True only when Google is authoritative for this address: the token's email
 *  is verified AND the address is Google-hosted consumer mail (gmail.com /
 *  googlemail.com) or the token's Workspace `hd` claim equals the email's
 *  domain. For any other address Google's `email_verified` does not prove the
 *  CURRENT owner (a reassigned or lapsed third-party address can still carry a
 *  stale Google account), so it must never link into an existing account.
 *  https://developers.google.com/identity/gsi/web/guides/verify-google-id-token */
export function googleAuthoritativeForEmail(g: Pick<GoogleIdentity, 'email' | 'emailVerified' | 'hostedDomain'>): boolean {
  if (!g.emailVerified) return false;
  const at = g.email.lastIndexOf('@');
  if (at < 1) return false;
  const domain = g.email.slice(at + 1).toLowerCase();
  if (GOOGLE_MAIL_DOMAINS.has(domain)) return true;
  return g.hostedDomain !== null && g.hostedDomain === domain;
}
