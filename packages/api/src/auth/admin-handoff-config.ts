// #355: ADMIN_HANDOFF_ISSUER / ADMIN_HANDOFF_CLIENTS parsing, dependency-free so env.ts validates both at startup (a
// typo fails the boot, never a request) and auth/admin-handoff.ts applies the same rules.
export interface HandoffClient { id: string; redirectUri: string; secretSha256: string }

const ID = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const isLocal = (u: URL) => u.hostname === 'localhost' || u.hostname === '127.0.0.1';

/** Parse ADMIN_HANDOFF_CLIENTS. Throws on any malformed entry: a typo must not silently register a looser client.
 *  Plain http callbacks are accepted only on localhost and only outside production. Error text never echoes input. */
export function parseHandoffClients(raw: string | undefined, production = false): HandoffClient[] {
  if (!raw) return [];
  let list: unknown;
  try { list = JSON.parse(raw); } catch { throw new Error('ADMIN_HANDOFF_CLIENTS is not valid JSON'); }
  if (!Array.isArray(list)) throw new Error('ADMIN_HANDOFF_CLIENTS must be a JSON array');
  const seen = new Set<string>();
  return list.map((c, i) => {
    const { id, redirectUri, secretSha256 } = (c ?? {}) as Record<string, unknown>;
    if (typeof id !== 'string' || !ID.test(id) || seen.has(id)) throw new Error(`ADMIN_HANDOFF_CLIENTS[${i}].id is missing, malformed or repeated`);
    if (typeof secretSha256 !== 'string' || !HEX64.test(secretSha256)) throw new Error(`ADMIN_HANDOFF_CLIENTS[${i}].secretSha256 must be 64 lowercase hex`);
    const bad = new Error(`ADMIN_HANDOFF_CLIENTS[${i}].redirectUri must be an exact https URL with no query, fragment or credentials`);
    if (typeof redirectUri !== 'string') throw bad;
    let u: URL;
    try { u = new URL(redirectUri); } catch { throw bad; }
    const schemeOk = u.protocol === 'https:' || (!production && isLocal(u) && u.protocol === 'http:');
    if (!schemeOk || u.username || u.password || u.search || u.hash || u.href !== redirectUri) throw bad;
    seen.add(id);
    return { id, redirectUri, secretSha256 };
  });
}

/** ADMIN_HANDOFF_ISSUER must be a bare origin (https; http only on localhost outside production). Returns the origin. */
export function parseHandoffIssuer(raw: string, production = false): string {
  const bad = new Error('ADMIN_HANDOFF_ISSUER must be a bare https origin (scheme://host[:port], no path)');
  let u: URL;
  try { u = new URL(raw); } catch { throw bad; }
  const schemeOk = u.protocol === 'https:' || (!production && isLocal(u) && u.protocol === 'http:');
  if (!schemeOk || u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '') || raw.replace(/\/$/, '') !== u.origin) throw bad;
  return u.origin;
}
