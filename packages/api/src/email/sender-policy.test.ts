import { describe, expect, it } from 'vitest';
import { assertAllowedSenders, isForbiddenSenderDomain, parseSenderDomainList } from './sender-policy.js';

describe('parseSenderDomainList', () => {
  it('lowercases, trims, and de-dupes a comma list', () => {
    expect(parseSenderDomainList(' Example.com, example.com ,Other.org')).toEqual(['example.com', 'other.org']);
  });

  it('returns [] for undefined/empty input', () => {
    expect(parseSenderDomainList(undefined)).toEqual([]);
    expect(parseSenderDomainList('')).toEqual([]);
    expect(parseSenderDomainList('  ,  ')).toEqual([]);
  });
});

describe('isForbiddenSenderDomain', () => {
  it('is always false when the domain list is empty (default, no-op)', () => {
    expect(isForbiddenSenderDomain('someone@damneddesigns.com', [])).toBe(false);
  });

  it('matches an exact domain', () => {
    expect(isForbiddenSenderDomain('info@damneddesigns.com', ['damneddesigns.com'])).toBe(true);
  });

  it('matches a subdomain of a forbidden domain', () => {
    expect(isForbiddenSenderDomain('info@mail.damneddesigns.com', ['damneddesigns.com'])).toBe(true);
  });

  it('does not match an unrelated domain', () => {
    expect(isForbiddenSenderDomain('info@example.com', ['damneddesigns.com'])).toBe(false);
  });

  it('does not match a domain that merely ends with the same characters (no dot boundary)', () => {
    expect(isForbiddenSenderDomain('info@notdamneddesigns.com', ['damneddesigns.com'])).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isForbiddenSenderDomain('Info@Damneddesigns.COM', ['damneddesigns.com'])).toBe(true);
  });

  it('returns false for an address with no @', () => {
    expect(isForbiddenSenderDomain('not-an-address', ['damneddesigns.com'])).toBe(false);
  });
});

describe('assertAllowedSenders', () => {
  it('is a no-op when domains is empty', () => {
    expect(() => assertAllowedSenders({ SMTP_FROM: 'x@damneddesigns.com' }, [])).not.toThrow();
  });

  it('throws naming the offending field when a value matches a forbidden domain', () => {
    expect(() => assertAllowedSenders({ SMTP_FROM: 'x@damneddesigns.com' }, ['damneddesigns.com'])).toThrow(/SMTP_FROM/);
  });

  it('does not throw when no field matches', () => {
    expect(() => assertAllowedSenders({ SMTP_FROM: 'x@example.com' }, ['damneddesigns.com'])).not.toThrow();
  });

  it('skips undefined fields', () => {
    expect(() => assertAllowedSenders({ SMTP_FROM: undefined }, ['damneddesigns.com'])).not.toThrow();
  });
});
