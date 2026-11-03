import { describe, expect, it } from 'vitest';
import { devDefaultStore, hostMatchesAny, normalizeHost, pickBestStoreForHost, stripHostPrefix } from './store-context.js';

describe('devDefaultStore', () => {
  it('defaults to "damned" when env.DEV_DEFAULT_STORE_SLUG is unset (identical to the prior hardcoded value)', () => {
    expect(devDefaultStore()).toBe('damned');
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

describe('hostMatchesAny: bare labels never suffix-match (audit 2026-11-02)', () => {
  it('an entry "com" does not claim *.com', () => {
    expect(hostMatchesAny('victim.com', ['com'])).toBe(false);
    expect(hostMatchesAny('com', ['com'])).toBe(true); // exact only
  });
});

describe('pickBestStoreForHost: deterministic resolution', () => {
  const row = (id: string, slug: string, hostnames: string[]) => ({ id, slug, config: { hostnames } });
  it('prefers an exact entry over a parent-domain entry, regardless of row order', () => {
    const parent = row('1', 'a', ['example.com']);
    const exact = row('2', 'b', ['shop.example.com']);
    expect(pickBestStoreForHost([parent, exact], 'shop.example.com')?.slug).toBe('b');
    expect(pickBestStoreForHost([exact, parent], 'shop.example.com')?.slug).toBe('b');
  });
  it('prefers the longest suffix', () => {
    const a = row('1', 'a', ['example.com']);
    const b = row('2', 'b', ['shop.example.com']);
    expect(pickBestStoreForHost([a, b], 'x.shop.example.com')?.slug).toBe('b');
    expect(pickBestStoreForHost([b, a], 'x.shop.example.com')?.slug).toBe('b');
  });
  it('ties break on slug, not row order', () => {
    const a = row('1', 'alpha', ['same.example']);
    const b = row('2', 'beta', ['same.example']);
    expect(pickBestStoreForHost([b, a], 'same.example')?.slug).toBe('alpha');
  });
  it('the literal host beats the prefix-stripped host', () => {
    const a = row('1', 'a', ['example.com']);
    const b = row('2', 'b', ['www.example.com']);
    expect(pickBestStoreForHost([a, b], 'www.example.com', 'example.com')?.slug).toBe('b');
  });
  it('returns null when nothing matches', () => {
    expect(pickBestStoreForHost([row('1', 'a', ['example.com'])], 'other.test')).toBeNull();
  });
});
