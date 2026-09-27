import { describe, expect, it } from 'vitest';
import { HttpError, requireInstallationAdmin } from './admin-helpers.js';
import type { AdminPrincipal } from '../auth/admin-session.js';

function principal(isInstallationAdmin: boolean): AdminPrincipal {
  return { id: 'admin-1', email: 'a@example.com', isInstallationAdmin, stores: [] };
}

describe('requireInstallationAdmin', () => {
  it('passes for an installation administrator', () => {
    expect(() => requireInstallationAdmin(principal(true))).not.toThrow();
  });

  it('rejects an ordinary admin — even one who owns every store — with 403', () => {
    const nonInstall = principal(false);
    nonInstall.stores = [
      { storeId: 's1', slug: 'a', name: 'A', currency: 'USD', taxRate: 0, shippingTaxable: false, role: 'owner', permissions: null },
      { storeId: 's2', slug: 'b', name: 'B', currency: 'USD', taxRate: 0, shippingTaxable: false, role: 'owner', permissions: null },
    ];
    try {
      requireInstallationAdmin(nonInstall);
      expect.fail('expected HttpError');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      expect((e as HttpError).status).toBe(403);
    }
  });
});
