import type { MiddlewareHandler } from 'hono';
import { errJson } from './lib/api-error.js';
import type { EnginePlugin, NumericRouteBodyLimit } from './sdk/types.js';

const FIELDS = new Set(['method', 'pathPrefix', 'finalSegment', 'maxBytes']);
const PROTECTED = /^\/(?:v1\/(?:admin|shop|apps|licenses|dl|pro|setup|webhooks|health|readyz|maintenance|openapi\.json)(?:\/|$)|api\/licenses(?:\/|$)|releases(?:\/|$)|\.well-known(?:\/|$))/i;

/** Numeric suffixes cannot contain `/`, so two distinct literal prefixes cannot overlap. */
export function resolveNumericRouteBodyLimits(plugins: readonly Pick<EnginePlugin, 'name' | 'bodyLimits'>[]): readonly NumericRouteBodyLimit[] {
  const result: NumericRouteBodyLimit[] = [];
  for (const plugin of plugins) {
    if (plugin.bodyLimits === undefined) continue;
    if (!Array.isArray(plugin.bodyLimits)) throw new Error(`plugin ${plugin.name}: bodyLimits must be an array`);
    for (const policy of plugin.bodyLimits) {
      if (!policy || ![Object.prototype, null].includes(Object.getPrototypeOf(policy))
        || Reflect.ownKeys(policy).some((key) => typeof key !== 'string' || !FIELDS.has(key))
        || Object.values(Object.getOwnPropertyDescriptors(policy)).some((descriptor) => !('value' in descriptor))) {
        throw new Error('numeric-route body policy must contain data only');
      }
      if (policy.method !== 'PUT' || policy.finalSegment !== 'ascii-digits') throw new Error('numeric-route body policy requires PUT and an ASCII-digits final segment');
      if (typeof policy.pathPrefix !== 'string' || /\s/.test(policy.pathPrefix) || !/^\/(?:[A-Za-z0-9._~-]+\/)+$/.test(policy.pathPrefix)
        || policy.pathPrefix.split('/').some((part: string) => part === '.' || part === '..')) {
        throw new Error('numeric-route body policy requires a literal absolute path prefix ending in /');
      }
      if (PROTECTED.test(policy.pathPrefix) || policy.pathPrefix.toLowerCase() === '/v1/') {
        throw new Error(`numeric-route body policy ${policy.pathPrefix} targets a protected engine namespace`);
      }
      if (!Number.isSafeInteger(policy.maxBytes) || policy.maxBytes <= 0) throw new Error('numeric-route body policy maxBytes must be a positive safe integer');
      if (result.some((entry) => entry.pathPrefix === policy.pathPrefix)) throw new Error(`duplicate numeric-route body policy ${policy.pathPrefix}`);
      result.push(Object.freeze({ method: 'PUT', pathPrefix: policy.pathPrefix, finalSegment: 'ascii-digits', maxBytes: policy.maxBytes }));
    }
  }
  return Object.freeze(result);
}

export function matchesNumericRouteBodyLimit(policy: NumericRouteBodyLimit, method: string, path: string): boolean {
  const suffix = path.slice(policy.pathPrefix.length);
  return method === policy.method && path.startsWith(policy.pathPrefix) && suffix.length > 0 && !/[^0-9]/.test(suffix);
}

/** Install a demand-driven cap before routing, without consuming bytes before route authentication. */
export function numericRouteBodyLimit(policy: NumericRouteBodyLimit): MiddlewareHandler {
  return async (c, next) => {
    const raw = c.req.raw;
    const input = raw.body;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let complete = input === null;
    let stopped = false;
    let bytes = 0;
    let failure: 400 | 413 | undefined;

    // Cancellation never reads or drains input, including rejected credentials and storage failures.
    const cancel = (reason: unknown) => {
      if (stopped || complete) return;
      stopped = true;
      const pending = reader ? reader.cancel(reason) : input?.cancel(reason);
      void pending?.catch(() => {});
    };
    const reject = (status: 400 | 413, reason: string) => {
      failure = status;
      cancel(reason);
      try { controller?.error(new Error(reason)); } catch { /* Stream already closed or canceled. */ }
    };
    const errorResponse = (status: 400 | 413) => {
      // A downstream catch-all may have described a different response body.
      c.header('Content-Length', undefined);
      c.header('Content-Encoding', undefined);
      return status === 413
        ? errJson(c, 413, 'PAYLOAD_TOO_LARGE', 'request body too large')
        : errJson(c, 400, 'BAD_REQUEST', 'invalid request body length');
    };
    const length = raw.headers.get('content-length');
    const declared = length === null ? undefined : Number(length);
    if (length !== null && (!length || /[^0-9]/.test(length) || !Number.isSafeInteger(declared))) {
      cancel('invalid content-length');
      return errorResponse(400);
    }
    if (declared !== undefined && declared > policy.maxBytes) {
      cancel('request body too large');
      return errorResponse(413);
    }
    if (!input && declared !== undefined && declared !== 0) return errorResponse(400);

    const onAbort = () => reject(400, 'request body aborted');
    raw.signal.addEventListener('abort', onAbort, { once: true });
    if (raw.signal.aborted) onAbort();
    if (input && !failure) {
      const counted = new ReadableStream<Uint8Array>({
        start(value) { controller = value; },
        async pull(value) {
          if (stopped) return;
          reader ??= input.getReader();
          try {
            const chunk = await reader.read();
            if (stopped) return;
            if (chunk.done) {
              if (declared !== undefined && declared !== bytes) {
                reject(400, 'request body length mismatch');
                return;
              }
              complete = true;
              reader.releaseLock();
              reader = undefined;
              value.close();
              return;
            }
            bytes += chunk.value.byteLength;
            if (bytes > policy.maxBytes) {
              reject(413, 'request body too large');
              return;
            }
            value.enqueue(chunk.value);
          } catch (error) {
            cancel(error);
            try { value.error(error); } catch { /* Already canceled. */ }
          }
        },
        cancel(reason) { cancel(reason); },
      }, { highWaterMark: 0 });
      c.req.raw = new Request(raw, { body: counted, duplex: 'half' } as RequestInit);
    }
    try {
      if (!failure) await next();
      // A handler cannot turn overflow into a 503/success, or acknowledge an incompletely consumed part.
      if (!failure && !complete && c.res.status >= 200 && c.res.status < 300) failure = 400;
      if (failure) {
        // Downstream already finalized the context; returning alone cannot replace that response in Hono.
        c.res = errorResponse(failure);
        return c.res;
      }
    } finally {
      raw.signal.removeEventListener('abort', onAbort);
      cancel('request handler finished');
    }
  };
}
