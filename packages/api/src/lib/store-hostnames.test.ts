import { describe, expect, it } from 'vitest';
import { findHostnameConflict, normalizeStoreHostname, validateStoreHostnames } from './store-hostnames.js';

describe('normalizeStoreHostname', () => {
  it('accepts ordinary FQDNs and normalises them', () => {
    expect(normalizeStoreHostname(' WWW.DamnedDesigns.com ')).toBe('www.damneddesigns.com');
    expect(normalizeStoreHostname('heardright.app')).toBe('heardright.app');
    expect(normalizeStoreHostname('shop.example.co.uk')).toBe('shop.example.co.uk');
    expect(normalizeStoreHostname('example.com.')).toBe('example.com');
    expect(normalizeStoreHostname('bücher.example')).toBeNull(); // punycode only
    expect(normalizeStoreHostname('xn--bcher-kva.example')).toBe('xn--bcher-kva.example');
  });
  it.each(['com', 'localhost', '*.example.com', '*', '.com', 'example', 'https://example.com', 'example.com/path',
    'example.com:8443', '127.0.0.1', 'a..b.com', '-a.example.com', 'a-.example.com', 'exa mple.com', 'co.uk', 'com.au', '', ' '])(
    'rejects %j', (bad) => { expect(normalizeStoreHostname(bad)).toBeNull(); });
  it('rejects an over-long name', () => {
    expect(normalizeStoreHostname(`${'a'.repeat(64)}.example.com`)).toBeNull();
    expect(normalizeStoreHostname(`${'a.'.repeat(130)}com`)).toBeNull();
  });
});

describe('validateStoreHostnames', () => {
  it('dedupes and reports every invalid entry', () => {
    expect(validateStoreHostnames(['A.example.com', 'a.example.com', 'b.example.com'])).toEqual({ ok: true, hostnames: ['a.example.com', 'b.example.com'] });
    expect(validateStoreHostnames(['a.example.com', 'com', '*.x.io'])).toEqual({ ok: false, invalid: ['com', '*.x.io'] });
  });
  it('accepts the live store hostname sets', () => {
    for (const set of [['www.damneddesigns.com', 'damneddesigns.com'], ['rottenhand.com', 'www.rottenhand.com'],
      ['heardright.app', 'viewright.cc', 'mailright.cc', 'coderight.cc', 'scraperight.cc']]) {
      expect(validateStoreHostnames(set).ok).toBe(true);
    }
  });
});

describe('findHostnameConflict', () => {
  it('flags equal and parent/child names, not look-alikes', () => {
    expect(findHostnameConflict(['a.example.com'], ['a.example.com'])).toEqual({ mine: 'a.example.com', theirs: 'a.example.com' });
    expect(findHostnameConflict(['shop.example.com'], ['example.com'])).not.toBeNull();
    expect(findHostnameConflict(['example.com'], ['shop.example.com'])).not.toBeNull();
    expect(findHostnameConflict(['notexample.com'], ['example.com'])).toBeNull();
  });
});
