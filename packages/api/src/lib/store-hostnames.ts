/**
 * Store hostname validation (security audit 2026-11-02, tenant routing). Pure and DB-free.
 *
 * store.config.hostnames picks the tenant per Host and feeds the credentialed shop CORS list, so an entry must be a
 * real, fully-qualified DNS name a tenant could plausibly own: never a bare TLD, a single label, a wildcard, an IP
 * literal, a URL or a public suffix. Matching is suffix based (see hostMatchesAny), so a loose entry such as "com"
 * would otherwise claim every .com host.
 */

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
/** Second-level registry labels under a two-letter country TLD (co.uk, com.au, ...). A two-label entry made of one of
 *  these plus a ccTLD is a public suffix, not a registrable domain. Not a full public-suffix list; the common cases. */
const REGISTRY_SLDS = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'mil', 'nic']);

/** Returns the normalised (trimmed, lowercased, one trailing dot dropped) hostname, or null when it is not an FQDN. */
export function normalizeStoreHostname(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let h = raw.trim().toLowerCase();
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (h.length < 4 || h.length > 253) return null;
  const labels = h.split('.');
  if (labels.length < 2) return null;
  if (!labels.every((l) => LABEL.test(l))) return null;
  if (!TLD.test(labels[labels.length - 1]!)) return null;
  if (labels.length === 2 && labels[1]!.length === 2 && REGISTRY_SLDS.has(labels[0]!)) return null;
  return h;
}

/** Whether a host list entry may take part in SUFFIX matching (a bare label such as "com" never does). */
export function isSuffixEligibleHostname(entry: string): boolean {
  return entry.includes('.') && !entry.startsWith('.') && !entry.endsWith('.');
}

/** Two hostnames conflict when they are equal or one is a subdomain of the other (suffix routing would overlap them). */
export function hostnamesOverlap(a: string, b: string): boolean {
  return a === b || a.endsWith('.' + b) || b.endsWith('.' + a);
}

export type HostnameValidation = { ok: true; hostnames: string[] } | { ok: false; invalid: string[] };

/** Validates and normalises a whole list (deduplicated, order preserved). */
export function validateStoreHostnames(list: readonly string[]): HostnameValidation {
  const out: string[] = [];
  const invalid: string[] = [];
  for (const raw of list) {
    const n = normalizeStoreHostname(raw);
    if (n === null) invalid.push(raw);
    else if (!out.includes(n)) out.push(n);
  }
  return invalid.length ? { ok: false, invalid } : { ok: true, hostnames: out };
}

/** The first (mine, theirs) pair that overlaps, or null. */
export function findHostnameConflict(mine: readonly string[], others: readonly string[]): { mine: string; theirs: string } | null {
  for (const m of mine) for (const t of others) if (hostnamesOverlap(m, t)) return { mine: m, theirs: t };
  return null;
}
