import { afterEach, describe, expect, it, vi } from 'vitest';

async function load(base: string | undefined, pathname = '/') {
  vi.resetModules();
  vi.stubEnv('VITE_ADMIN_BASE_PATH', base ?? '');
  vi.stubGlobal('location', { pathname });
  return import('./base-path');
}

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('admin base path', () => {
  it('is a no-op for a root-mounted admin', async () => {
    const m = await load(undefined, '/orders/X');
    expect(m.adminHref('/login')).toBe('/login');
    expect(m.currentAdminPath()).toBe('/orders/X');
  });

  it('prefixes full-page navigations with the sub-path mount', async () => {
    const m = await load('/admin/', '/admin/login');
    expect(m.adminHref('/login')).toBe('/admin/login');
    expect(m.adminHref('orders/X')).toBe('/admin/orders/X');
    expect(m.currentAdminPath()).toBe('/login');
  });

  it('does not strip a mount-lookalike prefix', async () => {
    const m = await load('/admin', '/administrator');
    expect(m.currentAdminPath()).toBe('/administrator');
  });
});
