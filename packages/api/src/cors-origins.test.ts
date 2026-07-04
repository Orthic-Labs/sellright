import { describe, expect, it } from 'vitest';
import { isAllowedOriginHost } from './cors-origins.js';

describe('isAllowedOriginHost', () => {
  it('allows a host matching a configured store hostname', () => {
    expect(isAllowedOriginHost('damned.example', ['damned.example'], false)).toBe(true);
  });

  it('allows a subdomain of a configured store hostname', () => {
    expect(isAllowedOriginHost('checkout.damned.example', ['damned.example'], false)).toBe(true);
  });

  it('rejects a host not in the configured list', () => {
    expect(isAllowedOriginHost('attacker.example', ['damned.example'], false)).toBe(false);
  });

  it('rejects an empty hostnames list even in dev, for a non-local host', () => {
    expect(isAllowedOriginHost('damned.example', [], true)).toBe(false);
  });

  it('allows localhost only when isDev is true', () => {
    expect(isAllowedOriginHost('localhost', [], true)).toBe(true);
    expect(isAllowedOriginHost('localhost', [], false)).toBe(false);
  });

  it('allows 127.0.0.1 only when isDev is true', () => {
    expect(isAllowedOriginHost('127.0.0.1', [], true)).toBe(true);
    expect(isAllowedOriginHost('127.0.0.1', [], false)).toBe(false);
  });

  it('the isDev localhost allowance is separate from store-configured hostnames', () => {
    // A store that explicitly lists 'localhost' in its hostnames still matches
    // via hostMatchesAny regardless of isDev — the isDev branch only ever
    // ADDS an allowance, it never restricts the explicit-config path.
    expect(isAllowedOriginHost('localhost', ['localhost'], false)).toBe(true);
  });
});
