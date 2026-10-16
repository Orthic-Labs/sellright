import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { openapiAdminOnly } from './app.js';

// P2: /v1/openapi.json is admin-only in production (it documents every admin route); dev/test keep it public.
describe('openapiAdminOnly', () => {
  const build = (prod: boolean) => {
    const app = new Hono();
    app.use('/v1/openapi.json', openapiAdminOnly(() => prod));
    app.get('/v1/openapi.json', (c) => c.json({ openapi: '3.0.0' }));
    return app;
  };
  it('production: anonymous callers get 401 and no contract', async () => {
    const res = await build(true).request('/v1/openapi.json');
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('openapi');
  });
  it('non-production: public, as before (client generation)', async () => {
    expect((await build(false).request('/v1/openapi.json')).status).toBe(200);
  });
});
