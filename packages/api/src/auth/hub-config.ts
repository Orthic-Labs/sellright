// #355 phase 2: the hub (saved-account broker) configuration, dependency-free so env.ts validates it at boot: a typo
// fails the boot, never a request. Error text never echoes the input (secrets live in these variables).
export interface HubTarget { id: string; label: string; origin: string; clientId: string; clientSecret: string }
export interface HubVaultKey { version: number; key: Buffer }

const ID = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const isLocal = (u: URL) => u.hostname === 'localhost' || u.hostname === '127.0.0.1';

/** A bare origin (scheme://host[:port], no path, query, fragment or credentials): https, or http on localhost outside production. */
function bareOrigin(raw: unknown, production: boolean): string | null {
  if (typeof raw !== 'string') return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  const schemeOk = u.protocol === 'https:' || (!production && isLocal(u) && u.protocol === 'http:');
  if (!schemeOk || u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '') || raw.replace(/\/$/, '') !== u.origin) return null;
  return u.origin;
}

/** HUB_ORIGIN: this hub's public origin; each target's enrolment callback is `${origin}/v1/hub/callback/<target id>`. */
export function parseHubOrigin(raw: string, production = false): string {
  const o = bareOrigin(raw, production);
  if (!o) throw new Error('HUB_ORIGIN must be a bare https origin (scheme://host[:port], no path)');
  return o;
}

export const hubCallbackUri = (hubOrigin: string, targetId: string) => `${hubOrigin}/v1/hub/callback/${targetId}`;

/** HUB_TARGETS: JSON array of {"id","label","origin","clientId","clientSecret"}. Destinations are fixed here; no request
 *  ever names a URL. The target registers {"id": clientId, "redirectUri": hubCallbackUri(...), "secretSha256"} (phase 1). */
export function parseHubTargets(raw: string | undefined, production = false): HubTarget[] {
  if (!raw) return [];
  let list: unknown;
  try { list = JSON.parse(raw); } catch { throw new Error('HUB_TARGETS is not valid JSON'); }
  if (!Array.isArray(list)) throw new Error('HUB_TARGETS must be a JSON array');
  const seen = new Set<string>();
  return list.map((t, i) => {
    const { id, label, origin, clientId, clientSecret } = (t ?? {}) as Record<string, unknown>;
    if (typeof id !== 'string' || !ID.test(id) || seen.has(id)) throw new Error(`HUB_TARGETS[${i}].id is missing, malformed or repeated`);
    if (typeof label !== 'string' || !label.trim() || label.length > 80) throw new Error(`HUB_TARGETS[${i}].label must be 1-80 characters`);
    const o = bareOrigin(origin, production);
    if (!o) throw new Error(`HUB_TARGETS[${i}].origin must be a bare https origin`);
    if (typeof clientId !== 'string' || !ID.test(clientId)) throw new Error(`HUB_TARGETS[${i}].clientId is missing or malformed`);
    if (typeof clientSecret !== 'string' || clientSecret.length < 32 || clientSecret.length > 256) throw new Error(`HUB_TARGETS[${i}].clientSecret must be 32-256 characters`);
    seen.add(id);
    return { id, label: label.trim(), origin: o, clientId, clientSecret };
  });
}

/** HUB_VAULT_KEYS: comma list of "<version>:<base64 of 32 bytes>". The highest version seals; every listed version opens,
 *  so a rotation adds a key and drops the old one only once no slot is sealed with it. */
export function parseHubVaultKeys(raw: string | undefined): HubVaultKey[] {
  if (!raw) return [];
  const keys = raw.split(',').map((part, i) => {
    const m = /^\s*(\d{1,6}):([A-Za-z0-9+/]{43}=)\s*$/.exec(part);
    const key = m ? Buffer.from(m[2]!, 'base64') : null;
    if (!m || !key || key.length !== 32) throw new Error(`HUB_VAULT_KEYS[${i}] must be <version>:<base64 of 32 bytes>`);
    return { version: Number(m[1]), key };
  });
  if (new Set(keys.map((k) => k.version)).size !== keys.length) throw new Error('HUB_VAULT_KEYS versions must be unique');
  return keys.sort((a, b) => a.version - b.version);
}
