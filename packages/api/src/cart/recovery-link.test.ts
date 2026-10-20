import { describe, expect, it } from 'vitest';
import { buildRecoveryUrl, RECOVERY_LINK_TTL_MS, signRecovery, verifyRecovery } from './recovery-link.js';

const KEY = 'test-key';
const STORE = 'aaaaaaaa-0000-4000-8000-000000000001';
const CART = 'bbbbbbbb-0000-4000-8000-000000000002';
const NOW = 1_800_000_000_000;

describe('cart recovery link', () => {
  const exp = NOW + RECOVERY_LINK_TTL_MS;
  const sig = signRecovery(STORE, CART, exp, KEY);

  it('verifies an untouched, unexpired link', () => {
    expect(verifyRecovery(STORE, CART, String(exp), sig, NOW, KEY)).toBe('ok');
  });
  it('rejects a tampered cart id, store id, expiry or signature', () => {
    expect(verifyRecovery(STORE, 'cccccccc-0000-4000-8000-000000000003', String(exp), sig, NOW, KEY)).toBe('invalid');
    expect(verifyRecovery('aaaaaaaa-0000-4000-8000-0000000000ff', CART, String(exp), sig, NOW, KEY)).toBe('invalid');
    expect(verifyRecovery(STORE, CART, String(exp + 1), sig, NOW, KEY)).toBe('invalid');
    expect(verifyRecovery(STORE, CART, String(exp), sig.replace(/^./, (c) => (c === 'a' ? 'b' : 'a')), NOW, KEY)).toBe('invalid');
    expect(verifyRecovery(STORE, CART, String(exp), 'nothex', NOW, KEY)).toBe('invalid');
    expect(verifyRecovery(STORE, CART, 'NaN', sig, NOW, KEY)).toBe('invalid');
  });
  it('rejects a signature from another secret', () => {
    expect(verifyRecovery(STORE, CART, String(exp), signRecovery(STORE, CART, exp, 'other'), NOW, KEY)).toBe('invalid');
  });
  it('reports expiry only for a validly signed link', () => {
    expect(verifyRecovery(STORE, CART, String(exp), sig, exp + 1, KEY)).toBe('expired');
    expect(verifyRecovery(STORE, CART, String(exp), sig, exp, KEY)).toBe('ok');
  });
  it('builds a 7-day URL that carries the cart id but never a token', () => {
    const url = new URL(buildRecoveryUrl('https://shop.example/', STORE, CART, NOW, KEY));
    expect(url.pathname).toBe(`/v1/shop/cart/recover/${CART}`);
    expect(Number(url.searchParams.get('exp'))).toBe(exp);
    expect(verifyRecovery(STORE, CART, url.searchParams.get('exp')!, url.searchParams.get('sig')!, NOW, KEY)).toBe('ok');
  });
});
