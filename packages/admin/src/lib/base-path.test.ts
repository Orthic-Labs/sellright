import { describe, expect, it } from 'vitest';
import { appHref, currentAppPath } from './base-path';

describe('base-path helpers (unmounted build)', () => {
  it('leaves paths untouched when no base path is configured', () => {
    expect(appHref('/login')).toBe('/login');
    expect(appHref('orders/X1')).toBe('/orders/X1');
    expect(currentAppPath('/login')).toBe('/login');
  });
});
