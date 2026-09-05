import { describe, expect, it } from 'vitest';
import { productionEnvErrors, resolveFileBackedEnv } from './env-runtime.js';

describe('resolveFileBackedEnv', () => {
  it('loads allowlisted KEY_FILE values and strips only trailing newlines', () => {
    const out = resolveFileBackedEnv(
      { DATABASE_URL_FILE: '/run/secrets/db', APNS_KEY_P8_FILE: '/run/secrets/apns' },
      (path) => path.endsWith('/db')
        ? 'postgres://user:pass@db:5432/sellright\n'
        : '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
    );
    expect(out.DATABASE_URL).toBe('postgres://user:pass@db:5432/sellright');
    expect(out.APNS_KEY_P8).toContain('\nabc\n');
    expect(out.APNS_KEY_P8?.endsWith('\n')).toBe(false);
  });

  it('prefers a direct value over KEY_FILE', () => {
    const out = resolveFileBackedEnv(
      { DATABASE_URL: 'postgres://direct/db', DATABASE_URL_FILE: '/run/secrets/db' },
      () => 'postgres://file/db',
    );
    expect(out.DATABASE_URL).toBe('postgres://direct/db');
  });

  it('does not read arbitrary non-allowlisted *_FILE variables', () => {
    let reads = 0;
    const out = resolveFileBackedEnv({ RANDOM_FILE: '/etc/passwd' }, () => { reads++; return 'x'; });
    expect(reads).toBe(0);
    expect(out.RANDOM).toBeUndefined();
  });
});

describe('productionEnvErrors', () => {
  it('allows local defaults outside production', () => {
    expect(productionEnvErrors({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://cp:cp@127.0.0.1:5433/sellright_dev',
      STOREFRONT_URL: 'https://store.example.com',
    }, {})).toEqual([]);
  });

  it('rejects implicit/dev database and example storefront settings in production', () => {
    const errors = productionEnvErrors({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://cp:cp@127.0.0.1:5433/sellright_dev',
      STOREFRONT_URL: 'https://store.example.com',
    }, {});
    expect(errors.some((e) => e.includes('explicitly configured'))).toBe(true);
    expect(errors.some((e) => e.includes('development/test'))).toBe(true);
    expect(errors.some((e) => e.includes('example.com'))).toBe(true);
  });

  it('accepts an explicit production database resolved from a file', () => {
    const source = resolveFileBackedEnv(
      { DATABASE_URL_FILE: '/run/secrets/db' },
      () => 'postgres://user:pass@postgres:5432/sellright',
    );
    expect(productionEnvErrors({
      NODE_ENV: 'production',
      DATABASE_URL: source.DATABASE_URL!,
      STOREFRONT_URL: 'https://shop.example-shop.com',
    }, source)).toEqual([]);
  });
});
