import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { describe, expect, it } from 'vitest';
import { routeInventory } from './route-inventory.js';

describe('routeInventory', () => {
  it('lists .openapi, .get, .on and path-param routes; flags undocumented ones', async () => {
    const app = new OpenAPIHono();
    app.openapi(createRoute({ method: 'get', path: '/v1/a/{id}', request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: 'ok' } } }), (c) => c.body(null, 200));
    app.get('/v1/plain/:slug', (c) => c.text('x'));
    app.on('PUT', '/v1/on', (c) => c.text('x'));
    app.on(['POST', 'DELETE'], '/v1/multi', (c) => c.text('x'));
    app.use('/v1/*', async (_c, next) => { await next(); });
    app.doc('/v1/openapi.json', { openapi: '3.0.0', info: { title: 't', version: '1' } });
    const inv = await routeInventory(app);
    const keys = inv.routes.map((r) => `${r.method} ${r.path}`);
    expect(keys).toEqual(expect.arrayContaining(['GET /v1/a/{id}', 'GET /v1/plain/{slug}', 'PUT /v1/on', 'POST /v1/multi', 'DELETE /v1/multi', 'GET /v1/openapi.json']));
    expect(inv.undocumented.map((r) => `${r.method} ${r.path}`)).toEqual(expect.arrayContaining(['GET /v1/plain/{slug}', 'PUT /v1/on', 'POST /v1/multi', 'DELETE /v1/multi']));
    expect(inv.documented.map((r) => r.path)).toContain('/v1/a/{id}');
    expect(inv.middleware).toContain('/v1/*');
    expect(inv.orphanedOpenApi).toEqual([]);
  });
});
