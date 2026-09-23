/**
 * Extension seam: shared outgoing-sender domain policy.
 *
 * Used both at boot (env.ts, via assertAllowedSenders) and per-send
 * (email/mailer.ts, via isForbiddenSenderDomain) so a fork gets ONE place to
 * declare "these sender domains must never be used", opts in with the
 * FORBIDDEN_SENDER_DOMAINS env var, and gets the same answer whether the
 * check runs at startup or at send time.
 *
 * Deliberately dependency-free (no `../env.js` import): both call sites pass
 * their own resolved domain list, so there is no import cycle between this
 * module and env.ts.
 */

/** Parse a comma-separated domain list into a lowercase, trimmed, de-duped array. */
export function parseSenderDomainList(raw: string | undefined): string[] {
  const seen = new Set<string>();
  for (const part of (raw ?? '').split(',')) {
    const domain = part.trim().toLowerCase();
    if (domain) seen.add(domain);
  }
  return [...seen];
}

function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at === -1 ? '' : address.slice(at + 1).toLowerCase();
}

/** True when `address`'s domain equals, or is a subdomain of, one of `domains`. */
export function isForbiddenSenderDomain(address: string, domains: readonly string[]): boolean {
  if (!domains.length) return false;
  const domain = domainOf(address);
  if (!domain) return false;
  return domains.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/**
 * Boot-time guard: throws when any of `fields` (label -> address, e.g.
 * `{ SMTP_FROM: env.SMTP_FROM }`) uses a domain in `domains`. A no-op when
 * `domains` is empty (FORBIDDEN_SENDER_DOMAINS unset — the default), so an
 * unconfigured deployment's boot is unchanged.
 */
export function assertAllowedSenders(fields: Record<string, string | undefined>, domains: readonly string[]): void {
  if (!domains.length) return;
  for (const [key, value] of Object.entries(fields)) {
    if (value && isForbiddenSenderDomain(value, domains)) {
      throw new Error(`${key} uses a forbidden sender domain (see FORBIDDEN_SENDER_DOMAINS): ${value}`);
    }
  }
}
