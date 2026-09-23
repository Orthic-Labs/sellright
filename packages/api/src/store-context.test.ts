import { describe, expect, it } from 'vitest';
import { DEV_DEFAULT_STORE, hostMatchesAny, normalizeHost, stripHostPrefix } from './store-context.js';

describe('DEV_DEFAULT_STORE', () => {
  it('defaults to "damned" when env.DEV_DEFAULT_STORE_SLUG is unset (identical to the prior hardcoded value)', () => {
    expect(DEV_DEFAULT_STORE).toBe('damned');
  });
});

describe('normalizeHost', () => {
  it('lowercases and strips a trailing port', () => {
    expect(normalizeHost('Damned.Example:8080')).toBe('damned.example');
  });

  it('handles a bare hostname with no port', () => {
    expect(normalizeHost('damned.example')).toBe('damned.example');
  });

  it('takes the first entry of a comma-separated X-Forwarded-Host chain', () => {
    expect(normalizeHost('damned.example, proxy.internal')).toBe('damned.example');
  });

  it('returns null for empty/undefined/whitespace-only input', () => {
    expect(normalizeHost(undefined)).toBeNull();
    expect(normalizeHost(null)).toBeNull();
    expect(normalizeHost('')).toBeNull();
    expect(normalizeHost('   ')).toBeNull();
  });
});

describe('hostMatchesAny', () => {
  it('matches an exact hostname', () => {
    expect(hostMatchesAny('damned.example', ['damned.example'])).toBe(true);
  });

  it('matches a subdomain of a configured hostname', () => {
    expect(hostMatchesAny('www.damned.example', ['damned.example'])).toBe(true);
  });

  it('does not match an unrelated host', () => {
    expect(hostMatchesAny('rotten.example', ['damned.example'])).toBe(false);
  });

  it('does not match a host that merely ends with the same characters (no dot boundary)', () => {
    // "notdamned.example" must NOT match "damned.example" — same bug class as
    // isAllowedRedirectHost guards against for redirect targets.
    expect(hostMatchesAny('notdamned.example', ['damned.example'])).toBe(false);
  });

  it('is case-insensitive on both sides', () => {
    expect(hostMatchesAny('WWW.Damned.Example', ['damned.EXAMPLE'])).toBe(true);
  });

  it('returns false against an empty hostnames list', () => {
    expect(hostMatchesAny('damned.example', [])).toBe(false);
  });

  it('skips blank entries in the hostnames list without matching everything', () => {
    expect(hostMatchesAny('damned.example', ['', '  '])).toBe(false);
  });
});

describe('stripHostPrefix', () => {
  it('is a no-op when the prefix list is empty (env.STORE_HOST_STRIP_PREFIXES unset, the default)', () => {
    expect(stripHostPrefix('buy.example.com', [])).toBe('buy.example.com');
  });

  it('strips a single matching leading label', () => {
    expect(stripHostPrefix('buy.example.com', ['www', 'buy', 'get', 'store'])).toBe('example.com');
  });

  it('is case-insensitive on the prefix match', () => {
    expect(stripHostPrefix('WWW.example.com', ['www'])).toBe('example.com');
  });

  it('leaves the host unchanged when its leading label is not in the prefix list', () => {
    expect(stripHostPrefix('shop.example.com', ['www', 'buy'])).toBe('shop.example.com');
  });

  it('never strips a bare two-label host down to a single label', () => {
    // "www" alone has no further label to strip to — must stay unchanged.
    expect(stripHostPrefix('www', ['www'])).toBe('www');
  });

  it('strips at most one label, never iterating', () => {
    // Only the leading "buy." is a candidate; "www" nested one level in is left alone.
    expect(stripHostPrefix('buy.www.example.com', ['www', 'buy'])).toBe('www.example.com');
  });
});
