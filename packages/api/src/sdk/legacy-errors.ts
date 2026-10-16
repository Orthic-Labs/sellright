/**
 * Legacy error shape support (plan 2.5). A composition that must keep a pre-existing wire
 * format (RightSites: `{error: "message", code, ...}` instead of the engine envelope
 * `{error: {code, message}}`) installs `legacyErrorShape()` as a `preRoute` policy and
 * documents each such route with `legacyErrorResponses(...)` + the `x-legacy-error-shape`
 * operation flag. `legacyExampleViolations()` fails when a flagged operation lacks a REAL example
 * for any of its 4xx/5xx responses; the route-inventory tests also execute the routes and
 * compare the live body with the documented example.
 */
import { z } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';

export const LEGACY_FLAG = 'x-legacy-error-shape' as const;

export interface LegacyErrorExample {
  error: string;
  code?: string;
  [extra: string]: unknown;
}

const legacyErrorSchema = z.object({ error: z.string(), code: z.string().optional() }).catchall(z.unknown());

/** OpenAPI `responses` entries for the given status -> example map. */
export function legacyErrorResponses<S extends number>(examples: Record<S, LegacyErrorExample>) {
  const out = {} as Record<S, { description: string; content: { 'application/json': { schema: typeof legacyErrorSchema; example: LegacyErrorExample } } }>;
  for (const [status, example] of Object.entries(examples) as Array<[string, LegacyErrorExample]>) {
    (out as Record<string, unknown>)[status] = {
      description: `Legacy-shape error (${status})`,
      content: { 'application/json': { schema: legacyErrorSchema, example } },
    };
  }
  return out;
}

/** Operations flagged `x-legacy-error-shape` whose 4xx/5xx responses lack a usable example. */
export function legacyExampleViolations(doc: { paths?: Record<string, Record<string, any>> }): string[] {
  const bad: string[] = [];
  for (const [path, ops] of Object.entries(doc.paths ?? {})) {
    for (const [method, op] of Object.entries(ops)) {
      if (!op || typeof op !== 'object' || op[LEGACY_FLAG] !== true) continue;
      const errorStatuses = Object.keys(op.responses ?? {}).filter((s) => /^[45]\d\d$/.test(s));
      if (errorStatuses.length === 0) bad.push(`${method.toUpperCase()} ${path}: no 4xx/5xx response documented`);
      for (const status of errorStatuses) {
        const example = op.responses[status]?.content?.['application/json']?.example;
        if (!example || typeof example !== 'object' || typeof example.error !== 'string') {
          bad.push(`${method.toUpperCase()} ${path}: ${status} has no legacy example {error: string, ...}`);
        }
      }
    }
  }
  return bad;
}

/** Paths that keep the engine's structured envelope. */
const DEFAULT_ENVELOPE_PREFIXES = ['/v1/admin'];

/**
 * Rewrites `{error:{code,message,...}}` bodies to `{error:"message", code, ...}` (top-level
 * siblings such as `reason` are preserved). Success and non-JSON responses pass through.
 */
export function legacyErrorShape(envelopePrefixes: readonly string[] = DEFAULT_ENVELOPE_PREFIXES): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const res = c.res;
    if (res.status < 400) return;
    if (envelopePrefixes.some((p) => c.req.path === p || c.req.path.startsWith(`${p}/`))) return;
    if (!(res.headers.get('content-type') ?? '').includes('application/json')) return;
    let body: unknown;
    try { body = await res.clone().json(); } catch { return; }
    if (!body || typeof body !== 'object') return;
    const err = (body as { error?: unknown }).error;
    if (!err || typeof err !== 'object' || typeof (err as { message?: unknown }).message !== 'string') return;
    const { code, message, param, requestId } = err as { code?: string; message: string; param?: string; requestId?: string };
    const legacy = { ...(body as Record<string, unknown>), error: message, ...(code ? { code } : {}), ...(param ? { param } : {}), ...(requestId ? { requestId } : {}) };
    const headers = new Headers(res.headers);
    headers.delete('content-length');
    c.res = new Response(JSON.stringify(legacy), { status: res.status, headers });
  };
}
