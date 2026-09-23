/**
 * Regression test for the staff-invite-accept 409 consistency fix: the route
 * previously `throw new HttpError(409, ...)` for an invalid/expired invite
 * instead of returning `c.json({ error }, 409)` directly, like its sibling
 * handlers in this file (all of which either `guard()`-wrap or return
 * directly). This handler is deliberately NOT wrapped in `guard()` (it's the
 * public accept endpoint), so a bare `throw` only produced the right status
 * when the top-level app.onError happened to be wired — mounting the router
 * in isolation (as this test and admin-settings-advanced.staff.db.test.ts
 * both do) would otherwise surface a generic 500 instead of 409.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';

vi.mock('../auth/admin-staff.js', () => ({
  createAdminUser: vi.fn(),
  findAdminIdByEmail: vi.fn(),
  findInviteByTokenHash: vi.fn().mockResolvedValue(null),
  listStoreInvites: vi.fn(),
  listStoreStaff: vi.fn(),
  setAdminPassword: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /v1/admin/staff/accept — invalid invite', () => {
  it('returns 409 with the error body directly, with no app-level error handler mounted', async () => {
    const { adminSettingsAdvanced } = await import('./admin-settings-advanced.js');
    const app = new OpenAPIHono();
    app.route('/', adminSettingsAdvanced);

    const res = await app.request('/v1/admin/staff/accept', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'not-a-real-token', password: 'password123' }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'invite is invalid, already used, or expired' });
  });
});
