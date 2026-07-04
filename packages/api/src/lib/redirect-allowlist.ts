// SEC-4: guards the licensed-download route from redirecting to an
// admin/staff-supplied artifact.path pointing at an arbitrary external host
// (malware-delivery phishing via a spoofed "official" download link).
//
// A URL is only an allowed redirect target when its hostname exactly matches
// one of the allowlisted suffixes, or is a subdomain of one.
export function isAllowedRedirectHost(url: string, allowlistCsv: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!hostname) return false;

  const suffixes = allowlistCsv
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);

  return suffixes.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
}
