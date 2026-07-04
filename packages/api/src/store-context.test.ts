import { describe, expect, it } from 'vitest';
import { hostMatchesAny, normalizeHost } from './store-context.js';

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
