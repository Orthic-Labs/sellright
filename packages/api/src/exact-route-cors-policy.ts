import type { Context } from 'hono';
import type { EnginePlugin, ExactRouteCorsPolicy } from './sdk/types.js';

const FIELDS = new Set(['path', 'origins', 'loopback', 'missingOrigin', 'fallbackOrigin', 'methods', 'headers', 'maxAge', 'credentials', 'options']);
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const TOKEN = /^[!#$%&'+.^_`|~0-9A-Za-z-]+$/;
const ENGINE_NAMESPACES = ['/v1', '/api/licenses', '/releases', '/.well-known'];

/** Shared exact-path boundary: no route syntax, escapes, URL normalization or engine namespace. */
export function assertPluginPolicyPath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || /\s/.test(path) || !/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*\/?$/.test(path)
    || path.split('/').some((part) => part === '.' || part === '..')) {
    throw new Error('plugin response policy requires an exact literal path');
  }
  const lower = path.toLowerCase();
  if (ENGINE_NAMESPACES.some((prefix) => lower === prefix || lower.startsWith(`${prefix}/`))) {
    throw new Error(`plugin response policy ${path} targets a protected engine namespace`);
  }
}

function isLiteralOrigin(origin: unknown): origin is string {
  if (origin === 'null') return true;
  if (typeof origin !== 'string' || !origin || /[\s*]/.test(origin)) return false;
  try {
    const url = new URL(origin);
    if (!url.hostname || url.username || url.password || url.search || url.hash) return false;
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin === origin;
    return !url.pathname && `${url.protocol}//${url.host}` === origin;
  } catch { return false; }
}

function stringList(value: unknown, field: string, valid: (entry: string) => boolean): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !valid(entry))) {
    throw new Error(`exact-route CORS ${field} must be an array of valid literal values`);
  }
  if (new Set(value.map((entry: string) => entry.toLowerCase())).size !== value.length) {
    throw new Error(`exact-route CORS ${field} contains duplicates`);
  }
  return [...value];
}

/** Copies policy data per app, so later plugin mutations cannot change validated response behavior. */
export function resolveExactRouteCorsPolicies(plugins: readonly Pick<EnginePlugin, 'name' | 'corsPolicies'>[]): ReadonlyMap<string, ExactRouteCorsPolicy> {
  const resolved = new Map<string, ExactRouteCorsPolicy>();
  for (const plugin of plugins) {
    if (plugin.corsPolicies === undefined) continue;
    if (!Array.isArray(plugin.corsPolicies)) throw new Error(`plugin ${plugin.name}: corsPolicies must be an array`);
    for (const policy of plugin.corsPolicies) {
      if (!policy || ![Object.prototype, null].includes(Object.getPrototypeOf(policy))
        || Reflect.ownKeys(policy).some((key) => typeof key !== 'string' || !FIELDS.has(key))
        || Object.values(Object.getOwnPropertyDescriptors(policy)).some((descriptor) => !('value' in descriptor))) {
        throw new Error(`plugin ${plugin.name}: exact-route CORS policy must contain data only`);
      }
      assertPluginPolicyPath(policy.path);
      if (resolved.has(policy.path)) throw new Error(`duplicate exact-route CORS policy for ${policy.path}`);
      if (policy.credentials !== 'absent') throw new Error('exact-route CORS credentials must be absent');
      if (policy.options !== 'respond-204' && policy.options !== 'continue') throw new Error('invalid exact-route CORS OPTIONS outcome');
      if (policy.loopback !== undefined && typeof policy.loopback !== 'boolean') throw new Error('invalid exact-route CORS loopback value');
      const origins = stringList(policy.origins, 'origins', isLiteralOrigin);
      const methods = stringList(policy.methods, 'methods', (method) => METHODS.has(method));
      const headers = stringList(policy.headers, 'headers', (header) => TOKEN.test(header));
      for (const field of ['missingOrigin', 'fallbackOrigin'] as const) {
        if (policy[field] !== undefined && policy[field] !== '*' && !isLiteralOrigin(policy[field])) {
          throw new Error(`invalid exact-route CORS ${field}`);
        }
      }
      if (policy.maxAge !== undefined && (!Number.isInteger(policy.maxAge) || policy.maxAge < 0 || policy.maxAge > 86400)) {
        throw new Error('exact-route CORS maxAge must be an integer from 0 through 86400');
      }
      resolved.set(policy.path, Object.freeze({
        path: policy.path, origins: Object.freeze(origins), methods: Object.freeze(methods), headers: Object.freeze(headers),
        loopback: policy.loopback, missingOrigin: policy.missingOrigin, fallbackOrigin: policy.fallbackOrigin,
        maxAge: policy.maxAge, credentials: 'absent', options: policy.options,
      }));
    }
  }
  return resolved;
}

function isLoopbackOrigin(origin: string): boolean {
  // Do not canonicalize away an explicitly supplied default port: the wire contract echoes it verbatim.
  if (/\s/.test(origin) || !/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?$/i.test(origin)) return false;
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/';
  } catch { return false; }
}

/** Replace every inherited CORS header, preserving other response headers and Vary tokens. */
export function normalizeExactRouteCorsResponse(c: Context, policy: ExactRouteCorsPolicy): void {
  const origin = c.req.header('origin');
  const allowed = !origin ? policy.missingOrigin
    : policy.origins.includes(origin) || (policy.loopback && isLoopbackOrigin(origin)) ? origin : policy.fallbackOrigin;
  const edit = (headers: Headers) => {
    for (const name of [...headers.keys()]) {
      if (name.toLowerCase().startsWith('access-control-')) headers.delete(name);
    }
    if (allowed !== undefined) headers.set('Access-Control-Allow-Origin', allowed);
    if (policy.methods.length) headers.set('Access-Control-Allow-Methods', policy.methods.join(', '));
    if (policy.headers.length) headers.set('Access-Control-Allow-Headers', policy.headers.join(', '));
    if (policy.maxAge !== undefined) headers.set('Access-Control-Max-Age', String(policy.maxAge));
    const vary = (headers.get('Vary') ?? '').split(',').map((value) => value.trim()).filter(Boolean);
    if (!vary.some((value) => value === '*' || value.toLowerCase() === 'origin')) vary.push('Origin');
    headers.set('Vary', vary.join(', '));
  };
  try { edit(c.res.headers); } catch {
    const headers = new Headers(c.res.headers);
    edit(headers);
    c.res = new Response(c.res.body, { status: c.res.status, statusText: c.res.statusText, headers });
    // Hono carries prior headers into response replacements; remove inherited CORS again.
    edit(c.res.headers);
  }
}
