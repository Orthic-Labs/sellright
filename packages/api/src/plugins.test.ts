import { afterEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { _clearApiPluginsForTest, listApiPlugins, registerApiPlugin } from './plugins.js';

afterEach(() => {
  _clearApiPluginsForTest();
});

describe('registerApiPlugin / listApiPlugins', () => {
  it('starts empty — nothing registered by default', () => {
    expect(listApiPlugins()).toEqual([]);
  });

  it('registers a plugin and returns it via listApiPlugins in order', () => {
    const routesA = new OpenAPIHono();
    const routesB = new OpenAPIHono();
    registerApiPlugin({ name: 'a', routes: routesA });
    registerApiPlugin({ name: 'b', routes: routesB });
    expect(listApiPlugins().map((p) => p.name)).toEqual(['a', 'b']);
    expect(listApiPlugins()[0]?.routes).toBe(routesA);
  });

  it('rejects a duplicate plugin name', () => {
    registerApiPlugin({ name: 'dup' });
    expect(() => registerApiPlugin({ name: 'dup' })).toThrow(/already registered/);
  });

  it('runs init hooks when createApp mounts registered plugins', async () => {
    const { createApp } = await import('./app.js');
    let initCalled = false;
    const routes = new OpenAPIHono();
    routes.get('/v1/my-plugin/ping', (c) => c.json({ ok: true }));
    registerApiPlugin({
      name: 'ping-plugin',
      routes,
      init: () => {
        initCalled = true;
      },
    });
    const app = createApp();
    const res = await app.request('/v1/my-plugin/ping');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(initCalled).toBe(true);
  });
});
