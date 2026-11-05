import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hubCallbackUri, parseHubOrigin, parseHubTargets, parseHubVaultKeys } from './hub-config.js';
import { open, seal } from './hub-vault.js';

const SECRET = 's'.repeat(40);
const target = (over: Record<string, unknown> = {}) => ({ id: 'shop', label: 'Shop', origin: 'https://shop.example', clientId: 'hub', clientSecret: SECRET, ...over });
const key = (v: number) => `${v}:${randomBytes(32).toString('base64')}`;

describe('hub configuration (#355 phase 2)', () => {
  it('accepts bare https origins only (http on localhost outside production)', () => {
    expect(parseHubOrigin('https://hub.example/')).toBe('https://hub.example');
    expect(parseHubOrigin('http://localhost:3000')).toBe('http://localhost:3000');
    for (const bad of ['https://hub.example/admin', 'http://hub.example', 'https://u:p@hub.example', 'https://hub.example?x=1', 'nope']) expect(() => parseHubOrigin(bad)).toThrow();
    expect(() => parseHubOrigin('http://localhost:3000', true)).toThrow();
    expect(hubCallbackUri('https://hub.example', 'shop')).toBe('https://hub.example/v1/hub/callback/shop');
  });

  it('parses targets strictly and never echoes secrets in errors', () => {
    expect(parseHubTargets(undefined)).toEqual([]);
    expect(parseHubTargets(JSON.stringify([target()]))).toEqual([target()]);
    const cases = [target({ id: 'A' }), target({ origin: 'https://shop.example/path' }), target({ clientSecret: 'short' }), target({ label: '' }), target({ clientId: '../x' })];
    for (const t of cases) expect(() => parseHubTargets(JSON.stringify([t]))).toThrow();
    expect(() => parseHubTargets(JSON.stringify([target(), target()]))).toThrow(/repeated/);
    expect(() => parseHubTargets('{')).toThrow();
    try { parseHubTargets(JSON.stringify([target({ clientSecret: 'leak-me' })])); } catch (e) { expect((e as Error).message).not.toContain('leak-me'); }
  });

  it('parses vault keys: 32 bytes, unique versions, sorted', () => {
    const keys = parseHubVaultKeys(`${key(2)}, ${key(1)}`);
    expect(keys.map((k) => k.version)).toEqual([1, 2]);
    expect(() => parseHubVaultKeys(`1:${randomBytes(16).toString('base64')}`)).toThrow();
    expect(() => parseHubVaultKeys(`${key(1)},${key(1)}`)).toThrow(/unique/);
  });
});

describe('hub vault', () => {
  const keys = parseHubVaultKeys(`${key(1)},${key(2)}`);
  it('seals with the newest key and opens only with the same binding', () => {
    const sealed = seal(keys, 'bearer-token', 'slot|a|b|c');
    expect(sealed.v).toBe(2);
    expect(JSON.stringify(sealed)).not.toContain('bearer-token');
    expect(open(keys, sealed, 'slot|a|b|c')).toBe('bearer-token');
    expect(() => open(keys, sealed, 'slot|other|b|c')).toThrow();
    expect(() => open(keys, { ...sealed, ct: Buffer.from('x').toString('base64') }, 'slot|a|b|c')).toThrow();
    expect(() => open(keys.slice(0, 1), sealed, 'slot|a|b|c')).toThrow(/version/);
  });
  it('keeps opening values sealed with an older key after rotation', () => {
    const old = seal(keys.slice(0, 1), 'v1', 'aad');
    expect(open(keys, old, 'aad')).toBe('v1');
  });
});
