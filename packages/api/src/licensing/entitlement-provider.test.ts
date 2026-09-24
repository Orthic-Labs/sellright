import { afterEach, describe, expect, it } from 'vitest';
import type { Tx } from '../db/client.js';
import {
  callEntitlementHook,
  clearEntitlementProvider,
  entitlementProvider,
  EntitlementVeto,
  registerEntitlementProvider,
  withEntitlementVeto,
} from './entitlement-provider.js';

// callEntitlementHook is pure orchestration (no DB access itself — it just
// invokes whatever hook a route passes in) so it's fully testable with a
// stub `tx` and stub context. It deliberately does NOT catch anything a hook
// throws (veto or otherwise) — that's what lets it propagate out of a
// route's `withStore(...)` callback and roll the transaction back. The
// DB-level rollback/no-partial-commit behavior is covered separately in
// routes/apps.entitlements-seam.db.test.ts.
const fakeTx = {} as Tx;

describe('callEntitlementHook', () => {
  it('no hook registered => null (no-op)', async () => {
    await expect(callEntitlementHook(undefined, fakeTx, { anything: true })).resolves.toBeNull();
  });

  it('a resolved hook => its return value passes through', async () => {
    const hook = async () => ({ signedToken: 'abc', tier: 'pro' });
    await expect(callEntitlementHook(hook, fakeTx, {})).resolves.toEqual({ signedToken: 'abc', tier: 'pro' });
  });

  it('a hook resolving void => null, not undefined', async () => {
    const hook = async () => undefined;
    await expect(callEntitlementHook(hook, fakeTx, {})).resolves.toBeNull();
  });

  it('a hook throwing EntitlementVeto propagates uncaught (so the enclosing transaction rolls back)', async () => {
    const veto = new EntitlementVeto(409, 'seat_limit_reached', 'no seats left');
    const hook = async () => { throw veto; };
    await expect(callEntitlementHook(hook, fakeTx, {})).rejects.toBe(veto);
  });

  it('a hook throwing any other error also propagates uncaught', async () => {
    const hook = async () => { throw new Error('boom — internal detail'); };
    await expect(callEntitlementHook(hook, fakeTx, {})).rejects.toThrow('boom — internal detail');
  });
});

describe('withEntitlementVeto', () => {
  // Minimal stand-in for Hono's Context — only `.json` is used.
  const c = { json: (body: unknown, status?: number) => new Response(JSON.stringify(body), { status: status ?? 200 }) };

  it('passes through a normal return value untouched', async () => {
    const result = await withEntitlementVeto(c, async () => ({ ok: true, value: 42 }));
    expect(result).toEqual({ ok: true, value: 42 });
  });

  it('turns a thrown EntitlementVeto into the route error shape, at its httpStatus', async () => {
    const veto = new EntitlementVeto(503, 'signing_unavailable', 'signer is down');
    const result = (await withEntitlementVeto(c, async () => { throw veto; })) as Response;
    expect(result.status).toBe(503);
    const body = await result.json();
    expect(body).toEqual({ ok: false, status: 'signing_unavailable', message: 'signer is down' });
  });

  it('rethrows any non-veto error unchanged, for the generic error handler to sanitize', async () => {
    await expect(withEntitlementVeto(c, async () => { throw new Error('leaked detail'); })).rejects.toThrow('leaked detail');
  });
});

describe('registerEntitlementProvider / clearEntitlementProvider', () => {
  afterEach(() => clearEntitlementProvider());

  it('defaults to null (no provider registered)', () => {
    expect(entitlementProvider()).toBeNull();
  });

  it('registers and returns the provider', () => {
    const provider = { onActivate: async () => ({ ok: true }) };
    registerEntitlementProvider(provider);
    expect(entitlementProvider()).toBe(provider);
  });

  it('registering again replaces the previous provider', () => {
    registerEntitlementProvider({ onActivate: async () => ({ v: 1 }) });
    const second = { onActivate: async () => ({ v: 2 }) };
    registerEntitlementProvider(second);
    expect(entitlementProvider()).toBe(second);
  });

  it('clearEntitlementProvider drops it back to null', () => {
    registerEntitlementProvider({ onTrial: async () => undefined });
    clearEntitlementProvider();
    expect(entitlementProvider()).toBeNull();
  });
});
