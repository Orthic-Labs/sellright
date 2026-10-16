import { describe, expect, it } from 'vitest';
import { isDisposablePostgresUrl, requireDisposablePostgresUrl } from './test-database-url.js';

describe('destructive fixture database URL guard', () => {
  it.each([
    'postgres://localhost/shop_test',
    'postgresql://fixture:secret@localhost:5432/shop_test',
    'postgres://fixture%40example:secret%2Fvalue@localhost/shop_test?application_name=ci&sslmode=require',
    'postgres://[::1]/shop_test',
    'postgres://localhost/shop%5Ftest',
    'postgres://localhost/%E5%BA%97_test',
  ])('accepts an explicit disposable database: %s', (value) => {
    expect(isDisposablePostgresUrl(value)).toBe(true);
    expect(() => requireDisposablePostgresUrl(value, 'fixture')).not.toThrow();
  });

  it.each([
    undefined, null, '', 'not a URL',
    'https://localhost/shop_test', 'file:///shop_test',
    'postgres:shop_test', 'postgres:///shop_test', 'postgres://localhost', 'postgres://localhost/',
    'postgres://localhost/_test',
    'postgres://fixture_test:secret@localhost/production',
    'postgres://fixture:secret_test@localhost/production',
    'postgres://fixture_test/production',
    'postgres://localhost/production?application_name=fixture_test',
    'postgres://localhost/shop_test_backup', 'postgres://localhost/shop_test-other',
    'postgres://localhost/shop_test/other', 'postgres://localhost/other/shop_test',
    'postgres://localhost/production/../shop_test', 'postgres://localhost/%2e%2e/shop_test',
    'postgres://localhost/shop%2Fother_test', 'postgres://localhost/shop%2fother_test',
    'postgres://localhost/shop%5Cother_test', 'postgres://localhost/shop\\other_test',
    'postgres://localhost/shop%00_test', 'postgres://localhost/shop%0A_test',
    'postgres://localhost/shop%7F_test', 'postgres://localhost/shop%C2%85_test',
    'postgres://localhost/shop\n_test', 'postgres://localhost/shop\t_test',
    ' postgres://localhost/shop_test', 'postgres://localhost/shop_test ',
    'postgres://localhost/shop%20_test', 'postgres://localhost/shop%_test',
    'postgres://localhost/shop%FF_test', 'postgres://user%:secret@localhost/shop_test',
    'postgres://user:%FF@localhost/shop_test', 'postgres://localhost/shop_test?application_name=%FF',
    'postgres://localhost/shop_test#production', 'postgres://localhost/shop_test#',
    'postgres://localhost:invalid/shop_test', 'postgres://localhost:65536/shop_test',
    'postgres://localhost/shop_test?database=production',
    'postgres://localhost/shop_test?dbname=production',
    'postgres://localhost/shop_test?DATABASE=production',
    'postgres://localhost/shop_test?%64atabase=production',
    'postgres://localhost/shop_test?dbname=shop_test&dbname=production',
    'postgres://localhost/shop_test?connectionString=postgres%3A%2F%2Flocalhost%2Fproduction',
  ])('rejects unsafe or ambiguous targets: %s', (value) => {
    expect(isDisposablePostgresUrl(value)).toBe(false);
    expect(() => requireDisposablePostgresUrl(value, 'fixture')).toThrow('disposable PostgreSQL database');
  });

  it('never displays URL credentials or query values in rejection errors', () => {
    const secret = 'fixture-password-secret';
    const url = `postgres://private-user:${secret}@private-host/production?application_name=${secret}`;
    let message = '';
    try { requireDisposablePostgresUrl(url, 'wipe fixture'); } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('wipe fixture');
    for (const privateValue of [secret, 'private-user', 'private-host', 'production', url]) {
      expect(message).not.toContain(privateValue);
    }
  });
});
