import { describe, expect, it, vi } from 'vitest';
import type { StoreCtx } from '../store-context.js';

// vi.mock factories are hoisted above all other top-level code in this file,
// so anything the factory references must itself be defined via vi.hoisted().
const { STORE_A, STORE_FALLBACK, FakeStoreSlugError } = vi.hoisted(() => {
  class FakeStoreSlugError extends Error {
    readonly httpStatus = 404 as const;
  }
  const storeA = {
    id: 'a', slug: 'a', name: 'A', currency: 'USD', taxRate: 0, taxInclusive: false, shippingTaxable: false, config: null,
  };
  const storeFallback = {
    id: 'fallback', slug: 'fallback', name: 'Fallback', currency: 'USD', taxRate: 0, taxInclusive: false, shippingTaxable: false, config: null,
  };
  return { STORE_A: storeA, STORE_FALLBACK: storeFallback, FakeStoreSlugError };
});

vi.mock('../store-context.js', () => ({
  StoreSlugError: FakeStoreSlugError,
  resolveStore: vi.fn(async (slug: string) => {
    if (slug === 'a') return STORE_A;
    if (slug === 'fallback') return STORE_FALLBACK;
    throw new FakeStoreSlugError(`unknown store: ${slug}`);
  }),
}));

import { resolveStore } from '../store-context.js';
import { resolveStoreWithFallback } from './app-store-fallback.js';

describe('resolveStoreWithFallback', () => {
  it('resolves the primary slug directly when it exists', async () => {
    await expect(resolveStoreWithFallback('a', undefined)).resolves.toBe(STORE_A as unknown as StoreCtx);
  });

  it('rethrows StoreSlugError when fallbackSlug is unset (default — unchanged behavior)', async () => {
    await expect(resolveStoreWithFallback('unknown', undefined)).rejects.toBeInstanceOf(FakeStoreSlugError);
  });

  it('falls back to fallbackSlug when the primary slug is unknown and a fallback is configured', async () => {
    await expect(resolveStoreWithFallback('unknown', 'fallback')).resolves.toBe(STORE_FALLBACK as unknown as StoreCtx);
  });

  it('does not use the fallback when the primary slug resolves successfully', async () => {
    await expect(resolveStoreWithFallback('a', 'fallback')).resolves.toBe(STORE_A as unknown as StoreCtx);
  });

  it('rethrows a non-StoreSlugError even when a fallback is configured', async () => {
    vi.mocked(resolveStore).mockImplementationOnce(async () => {
      throw new Error('boom: unrelated failure');
    });
    await expect(resolveStoreWithFallback('a', 'fallback')).rejects.toThrow('boom: unrelated failure');
  });
});
