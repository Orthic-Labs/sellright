import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const constructed = vi.hoisted(() => [] as Array<{ key: string; config: unknown }>);
vi.mock('stripe', () => ({
  default: class FakeStripe {
    constructor(key: string, config?: unknown) { constructed.push({ key, config }); }
  },
}));

import { STRIPE_API_VERSION, STRIPE_MAX_NETWORK_RETRIES, STRIPE_REQUEST_TIMEOUT_MS, STRIPE_TOTAL_DEADLINE_MS, newStripeClient } from './stripe-client.js';

const SRC = fileURLToPath(new URL('..', import.meta.url));
function productionSources(dir = SRC, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) productionSources(full, out);
    else if (/\.(ts|mjs|js)$/.test(name) && !/\.test\.(ts|js)$/.test(name)) out.push(full);
  }
  return out;
}

describe('Stripe request API version', () => {
  beforeEach(() => { constructed.length = 0; });

  it('is the version the previously deployed SDK (22.6.2) used, so SDK 23 does not change request behaviour', () => {
    expect(STRIPE_API_VERSION).toBe('2026-08-26.dahlia');
  });

  it('newStripeClient constructs every client with the explicit apiVersion constant', () => {
    newStripeClient('sk_test_a');
    newStripeClient('sk_live_b');
    const config = { apiVersion: STRIPE_API_VERSION, timeout: STRIPE_REQUEST_TIMEOUT_MS, maxNetworkRetries: STRIPE_MAX_NETWORK_RETRIES };
    expect(constructed).toEqual([
      { key: 'sk_test_a', config },
      { key: 'sk_live_b', config },
    ]);
  });

  it('no production code constructs a Stripe client any other way (only stripe-client.ts calls `new Stripe(`)', () => {
    const offenders = productionSources()
      .filter((f) => /\bnew\s+Stripe\s*\(/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual(['payments/stripe-client.ts']);
  });

  it('every production Stripe client site goes through the helper (no inline apiVersion either)', () => {
    const sources = Object.fromEntries(['payments/stripe.ts', 'routes/admin-payment-settings.ts'].map((f) => [f, readFileSync(join(SRC, f), 'utf8')]));
    expect(sources['payments/stripe.ts']!.match(/newStripeClient\(/g)).toHaveLength(2); // resolveStripeClient + webhook verifier
    expect(sources['routes/admin-payment-settings.ts']!.match(/newStripeClient\(/g)).toHaveLength(3); // key verify + webhook provision + wallet domain registration
    for (const src of Object.values(sources)) expect(src).not.toMatch(/apiVersion/);
  });
});

describe('A7/C1 explicit Stripe deadlines', () => {
  it('sets the per-attempt timeout explicitly, well under the SDK default 80s', () => {
    expect(STRIPE_REQUEST_TIMEOUT_MS).toBe(20_000);
    expect(STRIPE_MAX_NETWORK_RETRIES).toBe(1);
  });
  it('bounds total elapsed time: attempts x timeout + the SDK max retry backoff (5s each)', () => {
    expect(STRIPE_TOTAL_DEADLINE_MS).toBe((STRIPE_MAX_NETWORK_RETRIES + 1) * STRIPE_REQUEST_TIMEOUT_MS + STRIPE_MAX_NETWORK_RETRIES * 5_000);
    expect(STRIPE_TOTAL_DEADLINE_MS).toBeLessThanOrEqual(45_000);
  });
});
