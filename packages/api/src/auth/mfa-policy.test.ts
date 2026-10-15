import { describe, expect, it } from 'vitest';
import { totpRequiredFor } from './mfa-policy.js';
import type { AdminStoreAccess } from './admin-session.js';

const store = (role: AdminStoreAccess['role'], requireTotp = false) => ({ storeId: 's', slug: 's', name: 's', currency: 'USD', taxRate: 0, shippingTaxable: false, role, permissions: null, requireTotp });
const human = (stores: ReturnType<typeof store>[], isInstallationAdmin = false) => ({ kind: 'human' as const, isInstallationAdmin, stores });

describe('totpRequiredFor (P1b)', () => {
  it("'off': only a store that requires it, and only for its owners/managers", () => {
    expect(totpRequiredFor(human([store('owner')]), 'off')).toBe(false);
    expect(totpRequiredFor(human([store('owner', true)]), 'off')).toBe(true);
    expect(totpRequiredFor(human([store('manager', true)]), 'off')).toBe(true);
    expect(totpRequiredFor(human([store('staff', true)]), 'off')).toBe(false);
    expect(totpRequiredFor(human([], true), 'off')).toBe(false);
  });
  it("'privileged': every installation admin and every owner/manager", () => {
    expect(totpRequiredFor(human([], true), 'privileged')).toBe(true);
    expect(totpRequiredFor(human([store('manager')]), 'privileged')).toBe(true);
    expect(totpRequiredFor(human([store('staff'), store('read_only')]), 'privileged')).toBe(false);
  });
  it("'all': every human; never an agent", () => {
    expect(totpRequiredFor(human([store('read_only')]), 'all')).toBe(true);
    expect(totpRequiredFor({ kind: 'agent', isInstallationAdmin: false, stores: [store('manager', true)] }, 'all')).toBe(false);
  });
});
