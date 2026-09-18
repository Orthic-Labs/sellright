/**
 * Unit tests for `verifyAcrossEnvironments` (ported upstream from RightSites'
 * storekit-sandbox-path lane; already dependency-free — no Apple SDK import).
 * Run with:
 *   ./node_modules/.bin/vitest run src/licensing/storekit-verify-environments.test.ts
 * from packages/api.
 */
import { describe, expect, it, vi } from 'vitest';
import { verifyAcrossEnvironments } from './storekit-verify-environments.js';

type FakeResult = { kind: 'ok'; value: string } | { kind: 'wrong_environment' } | { kind: 'bad_signature' } | { kind: 'revoked' };

describe('verifyAcrossEnvironments', () => {
  it('returns the first attempt that matches (ok) and labels it', async () => {
    const prod = vi.fn(async (): Promise<FakeResult> => ({ kind: 'ok', value: 'prod-payload' }));
    const sandbox = vi.fn(async (): Promise<FakeResult> => ({ kind: 'ok', value: 'sandbox-payload' }));
    const out = await verifyAcrossEnvironments('jws', [
      { label: 'Production', verify: prod },
      { label: 'Sandbox', verify: sandbox },
    ]);
    expect(out.result.kind).toBe('ok');
    expect(out.matchedLabel).toBe('Production');
    expect(prod).toHaveBeenCalledTimes(1);
    // Production matched — Sandbox must never even be tried. This is the
    // property that keeps a genuinely-Production transaction from ever
    // being handed to a Sandbox-pinned verifier.
    expect(sandbox).not.toHaveBeenCalled();
  });

  it('falls through past a wrong_environment result to the next attempt', async () => {
    const prod = vi.fn(async (): Promise<FakeResult> => ({ kind: 'wrong_environment' }));
    const sandbox = vi.fn(async (): Promise<FakeResult> => ({ kind: 'ok', value: 'sandbox-payload' }));
    const out = await verifyAcrossEnvironments('jws', [
      { label: 'Production', verify: prod },
      { label: 'Sandbox', verify: sandbox },
    ]);
    expect(out.result.kind).toBe('ok');
    expect(out.matchedLabel).toBe('Sandbox');
    expect(prod).toHaveBeenCalledTimes(1);
    expect(sandbox).toHaveBeenCalledTimes(1);
  });

  it('does NOT fall through on a real failure for the matching environment (bad_signature)', async () => {
    // This is the crux of the isolation design: a Production-pinned
    // verifier that ACTUALLY matched (right bundle, right environment
    // claim) but found a bad signature must not have its failure masked
    // by silently trying Sandbox next — that would let an attacker probe
    // for whichever environment's verifier is more permissive.
    const prod = vi.fn(async (): Promise<FakeResult> => ({ kind: 'bad_signature' }));
    const sandbox = vi.fn(async (): Promise<FakeResult> => ({ kind: 'ok', value: 'sandbox-payload' }));
    const out = await verifyAcrossEnvironments('jws', [
      { label: 'Production', verify: prod },
      { label: 'Sandbox', verify: sandbox },
    ]);
    expect(out.result.kind).toBe('bad_signature');
    expect(out.matchedLabel).toBeNull();
    expect(sandbox).not.toHaveBeenCalled();
  });

  it('does NOT fall through on revoked either', async () => {
    const prod = vi.fn(async (): Promise<FakeResult> => ({ kind: 'revoked' }));
    const sandbox = vi.fn(async (): Promise<FakeResult> => ({ kind: 'ok', value: 'x' }));
    const out = await verifyAcrossEnvironments('jws', [
      { label: 'Production', verify: prod },
      { label: 'Sandbox', verify: sandbox },
    ]);
    expect(out.result.kind).toBe('revoked');
    expect(out.matchedLabel).toBeNull();
    expect(sandbox).not.toHaveBeenCalled();
  });

  it('when every attempt is wrong_environment, returns wrong_environment with no matched label', async () => {
    const prod = vi.fn(async (): Promise<FakeResult> => ({ kind: 'wrong_environment' }));
    const sandbox = vi.fn(async (): Promise<FakeResult> => ({ kind: 'wrong_environment' }));
    const out = await verifyAcrossEnvironments('jws', [
      { label: 'Production', verify: prod },
      { label: 'Sandbox', verify: sandbox },
    ]);
    expect(out.result.kind).toBe('wrong_environment');
    expect(out.matchedLabel).toBeNull();
  });

  it('with only a single (Sandbox) attempt configured, Production is never even tried', async () => {
    // Models the "Production unconfigured (no appAppleId)" deployment
    // state: only a Sandbox attempt is constructed at all, so Production
    // transactions can never match by construction, not merely by
    // rejection after the fact.
    const sandbox = vi.fn(async (): Promise<FakeResult> => ({ kind: 'ok', value: 'sandbox-payload' }));
    const out = await verifyAcrossEnvironments('jws', [{ label: 'Sandbox', verify: sandbox }]);
    expect(out.result.kind).toBe('ok');
    expect(out.matchedLabel).toBe('Sandbox');
  });

  it('throws if called with zero configured attempts (caller bug, not "no match")', async () => {
    await expect(verifyAcrossEnvironments('jws', [])).rejects.toThrow(/no environment attempts configured/);
  });

  it('tries attempts strictly in order (Production before Sandbox) and stops at the first non-continue result', async () => {
    const calls: string[] = [];
    const prod = vi.fn(async (): Promise<FakeResult> => {
      calls.push('prod');
      return { kind: 'wrong_environment' };
    });
    const sandbox = vi.fn(async (): Promise<FakeResult> => {
      calls.push('sandbox');
      return { kind: 'ok', value: 'x' };
    });
    await verifyAcrossEnvironments('jws', [
      { label: 'Production', verify: prod },
      { label: 'Sandbox', verify: sandbox },
    ]);
    expect(calls).toEqual(['prod', 'sandbox']);
  });
});
