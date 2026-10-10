import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { describe, expect, it } from 'vitest';
import { HttpError, errBody } from '../routes/admin-helpers.js';
import { LEGACY_FLAG, legacyErrorResponses, legacyErrorShape, legacyExampleViolations } from './legacy-errors.js';
import { routeInventory } from './route-inventory.js';

const CONFLICT = { error: 'sample conflict', code: 'sample_conflict' };

function app() {
  const a = new OpenAPIHono();
  a.use('*', legacyErrorShape());
  a.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: { code: err.code, message: err.message } }, err.status);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'internal error' } }, 500);
  });
  a.openapi(
    createRoute({
      method: 'get', path: '/v1/legacy/ok', [LEGACY_FLAG]: true,
      responses: { 200: { description: 'ok' }, ...legacyErrorResponses({ 409: CONFLICT }) },
    }),
    () => { throw new HttpError(409, 'sample conflict', 'sample_conflict'); },
  );
  a.openapi(
    createRoute({ method: 'get', path: '/v1/envelope/x', responses: { 200: { description: 'ok' }, 400: { description: 'bad', ...errBody } } }),
    () => { throw new HttpError(400, 'nope', 'nope'); },
  );
  a.get('/v1/legacy/plain', () => { throw new HttpError(409, 'sample conflict', 'sample_conflict'); });
  a.on('PUT', '/v1/legacy/on', () => { throw new HttpError(409, 'sample conflict', 'sample_conflict'); });
  a.doc('/v1/openapi.json', { openapi: '3.0.0', info: { title: 't', version: '1' } });
  return a;
}

describe('legacy error examples (plan 2.5)', () => {
  it('a flagged route documents a real example and the live body equals it', async () => {
    const a = app();
    const doc = await (await a.request('/v1/openapi.json')).json() as any;
    expect(legacyExampleViolations(doc)).toEqual([]);
    const example = doc.paths['/v1/legacy/ok'].get.responses['409'].content['application/json'].example;
    expect(example).toEqual(CONFLICT);
    const live = await a.request('/v1/legacy/ok');
    expect(live.status).toBe(409);
    expect(await live.json()).toEqual(example);
  });

  it('undocumented .get() and .on() routes are inventoried and share the legacy wire shape', async () => {
    const a = app();
    const inv = await routeInventory(a);
    const undocumented = inv.undocumented.map((r) => `${r.method} ${r.path}`);
    expect(undocumented).toEqual(expect.arrayContaining(['GET /v1/legacy/plain', 'PUT /v1/legacy/on']));
    for (const [method, path] of [['GET', '/v1/legacy/plain'], ['PUT', '/v1/legacy/on']]) {
      const res = await a.request(path!, { method });
      expect(await res.json()).toEqual(CONFLICT);
    }
  });

  it('the envelope is kept where the flag is absent only for configured prefixes (admin)', async () => {
    const res = await app().request('/v1/envelope/x');
    expect(await res.json()).toEqual({ error: 'nope', code: 'nope' }); // non-admin path: legacy shape
  });

  it('flags a flagged operation with a missing or malformed example', () => {
    const doc = { paths: {
      '/a': { get: { [LEGACY_FLAG]: true, responses: { 200: {}, 409: { content: { 'application/json': { schema: {} } } } } } },
      '/b': { get: { [LEGACY_FLAG]: true, responses: { 200: {} } } },
      '/c': { get: { [LEGACY_FLAG]: true, responses: { 400: { content: { 'application/json': { example: { error: { code: 'x' } } } } } } } },
      '/d': { get: { responses: { 500: {} } } },
    } };
    expect(legacyExampleViolations(doc)).toEqual([
      'GET /a: 409 has no legacy example {error: string, ...}',
      'GET /b: no 4xx/5xx response documented',
      'GET /c: 400 has no legacy example {error: string, ...}',
    ]);
  });
});
