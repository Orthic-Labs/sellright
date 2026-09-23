import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';

/**
 * Moved out of deploy/demo/admin-login-isolation.test.mjs (2026-09-23): that
 * demo-safety job intentionally runs `node --check`/`node --test` against
 * plain .mjs files with no install/build step, so it can never import a
 * built packages/api/dist/app.js. This assertion belongs with the real
 * route's own test suite instead, where vitest resolves `createApp` straight
 * from TypeScript source — no build required, and it now runs on every push/
 * PR that touches the real login route, not just the demo wrapper.
 *
 * The published "Demo login: admin / admin" credential must only ever be
 * honored by the isolated demo wrapper (deploy/demo/interactive-server.mjs
 * intercepts POST /v1/admin/login before it reaches this real app). This
 * proves the real route rejects the same literal pair at the request-schema
 * layer, before any database lookup.
 */
describe('POST /v1/admin/login schema boundary', () => {
  it("rejects the literal 'admin'/'admin' pair via schema validation, never a 200 — no live DB required for this to fail", async () => {
    const app = createApp();
    const res = await app.request('/v1/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin', password: 'admin' }),
    });
    // Zod's `.email()` rejects the bare literal "admin" (no @) at the request
    // schema layer — a 400, never the 200 the demo wrapper returns for the
    // same credentials on its own /v1/admin/login interception.
    assertBadRequest(res.status);
  });
});

function assertBadRequest(status: number) {
  expect(status).toBe(400);
  expect(status).not.toBe(200);
}
