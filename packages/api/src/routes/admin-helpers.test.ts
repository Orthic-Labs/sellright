import { describe, expect, it } from 'vitest';
import { HttpError, hasPermission, requireHuman, requireInstallationAdmin, requireStepUp, STEP_UP_REQUIRED_MESSAGE } from './admin-helpers.js';
import type { AdminPrincipal } from '../auth/admin-session.js';

function principal(isInstallationAdmin: boolean, stepUpAt: Date | null = null): AdminPrincipal {
  return { id: 'admin-1', stepUpEpoch: null, securityEpoch: 0, email: 'a@example.com', kind: 'human', auth: 'session', apiTokenId: null, isInstallationAdmin, stepUpAt, stores: [] };
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

describe('requireStepUp', () => {
  it('passes when the session stepped up within the last 5 minutes', () => {
    const fresh = principal(true, new Date(Date.now() - 60_000));
    expect(() => requireStepUp(fresh)).not.toThrow();
  });

  it('rejects with a step-up-required 403 when never stepped up', () => {
    const never = principal(true, null);
    try {
      requireStepUp(never);
      expect.fail('expected HttpError');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      expect((e as HttpError).status).toBe(403);
      expect((e as HttpError).message).toBe(STEP_UP_REQUIRED_MESSAGE);
    }
  });

  it('rejects a step-up older than 5 minutes — no silent extension', () => {
    const stale = principal(true, new Date(Date.now() - 6 * 60 * 1000));
    expect(() => requireStepUp(stale)).toThrow(HttpError);
  });

  it('accepts right at the boundary but rejects just past it', () => {
    const justInside = principal(true, new Date(Date.now() - 5 * 60 * 1000 + 1000));
    expect(() => requireStepUp(justInside)).not.toThrow();
    const justOutside = principal(true, new Date(Date.now() - 5 * 60 * 1000 - 1000));
    expect(() => requireStepUp(justOutside)).toThrow(HttpError);
  });
});

describe('agent kind guards', () => {
  const agent = { id: 'a', email: 'a@agents.invalid', kind: 'agent', auth: 'api_token', apiTokenId: 't', isInstallationAdmin: false, stepUpAt: new Date(), stepUpEpoch: null, securityEpoch: 0, stores: [] } as const;
  it('requireHuman refuses agents', () => { expect(() => requireHuman(agent as never)).toThrow(); });
  it('requireStepUp refuses agents even with a fresh stepUpAt', () => { expect(() => requireStepUp(agent as never)).toThrow(); });
  it('requireInstallationAdmin refuses agents', () => { expect(() => requireInstallationAdmin({ ...agent, isInstallationAdmin: true } as never)).toThrow(); });
  it('hasPermission applies grants to agents like humans (the deny set, not the matrix, blocks irreversible routes)', () => {
    const st = { storeId: 's', slug: 's', name: 's', currency: 'USD', taxRate: 0, shippingTaxable: false, role: 'staff', permissions: { webhooks: true } } as const;
    expect(hasPermission(st as never, 'webhooks')).toBe(true); expect(hasPermission(st as never, 'refunds')).toBe(false);
  });
});
