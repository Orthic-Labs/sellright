import { afterEach, describe, expect, it, vi } from 'vitest';

// Import the actual harness with inert effect boundaries, not a copied guard or lifecycle.
function fixture(databaseUrl: string | undefined) {
  vi.resetModules();
  vi.stubEnv('DATABASE_URL', databaseUrl);
  const setup = vi.fn();
  const teardown = vi.fn();
  const connect = vi.fn().mockResolvedValue(undefined);
  const query = vi.fn().mockResolvedValue(undefined);
  const end = vi.fn().mockResolvedValue(undefined);
  const Client = vi.fn(function () { return { connect, query, end }; });
  const execFileSync = vi.fn().mockReturnValue('RESULT {}\n');
  const mkdtempSync = vi.fn().mockReturnValue('/fixture/packed');
  const rmSync = vi.fn();
  vi.doMock('pg', () => ({ default: { Client } }));
  vi.doMock('node:child_process', () => ({ execFileSync }));
  vi.doMock('node:fs', () => ({
    copyFileSync: vi.fn(), existsSync: vi.fn().mockReturnValue(true), mkdirSync: vi.fn(),
    mkdtempSync, rmSync, writeFileSync: vi.fn(),
  }));
  vi.doMock('vitest', () => ({
    beforeAll: setup, afterAll: teardown, describe: vi.fn(), it: vi.fn(), expect: vi.fn(),
  }));
  return {
    load: () => import('./packed.test.js'),
    setup, teardown, Client, connect, query, end, execFileSync, mkdtempSync, rmSync,
  };
}

afterEach(() => {
  for (const specifier of ['pg', 'node:child_process', 'node:fs', 'vitest']) vi.doUnmock(specifier);
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('packed harness database safety', () => {
  it.each([
    undefined, '',
    'postgres://fixture:secret@localhost/production',
    'postgres://fixture_test:secret@localhost/production',
    'postgres://localhost/production?application_name=fixture_test',
    'postgres://localhost/shop_test?database=production',
    'postgres://localhost/shop_test?%64atabase=production',
    'postgres://localhost/shop_test?dbname=production',
    'postgres://localhost/shop_test?connectionString=postgres%3A%2F%2Flocalhost%2Fproduction',
    'postgres://localhost/shop_test#production',
  ])('rejects an unsafe target before registering setup or teardown: %s', async (databaseUrl) => {
    const h = fixture(databaseUrl);
    await expect(h.load()).rejects.toThrow('disposable PostgreSQL database');
    expect(h.setup).not.toHaveBeenCalled();
    expect(h.teardown).not.toHaveBeenCalled();
    expect(h.Client).not.toHaveBeenCalled();
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.query).not.toHaveBeenCalled();
    expect(h.execFileSync).not.toHaveBeenCalled();
    expect(h.mkdtempSync).not.toHaveBeenCalled();
  });

  it('does not expose credentials or URL query values in rejection errors', async () => {
    const h = fixture('postgres://private-user:private-password@private-host/production?application_name=private-query');
    const error = await h.load().catch((failure: Error) => failure);
    expect(error).toBeInstanceOf(Error);
    for (const value of ['private-user', 'private-password', 'private-host', 'production', 'private-query']) {
      expect((error as Error).message).not.toContain(value);
    }
  });

  it('does not open a cleanup connection after setup fails before database access', async () => {
    const h = fixture('postgres://localhost/shop_test');
    await h.load();
    h.execFileSync.mockImplementationOnce(() => { throw new Error('pack failed'); });
    await expect(h.setup.mock.calls[0][0]()).rejects.toThrow('pack failed');
    await h.teardown.mock.calls[0][0]();
    expect(h.Client).not.toHaveBeenCalled();
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.query).not.toHaveBeenCalled();
    expect(h.rmSync).toHaveBeenCalledWith('/fixture/packed', { recursive: true, force: true });
  });

  it('does not open a cleanup connection when setup cannot connect', async () => {
    const h = fixture('postgres://localhost/shop_test');
    await h.load();
    h.connect.mockRejectedValueOnce(new Error('connection failed'));
    await expect(h.setup.mock.calls[0][0]()).rejects.toThrow('connection failed');
    await h.teardown.mock.calls[0][0]();
    expect(h.Client).toHaveBeenCalledTimes(1);
    expect(h.connect).toHaveBeenCalledTimes(1);
    expect(h.query).not.toHaveBeenCalled();
    expect(h.end).toHaveBeenCalledTimes(1);
  });

  it('closes the cleanup client if its connection fails after a partial seed', async () => {
    const h = fixture('postgres://localhost/shop_test');
    await h.load();
    h.query.mockRejectedValueOnce(new Error('seed failed'));
    await expect(h.setup.mock.calls[0][0]()).rejects.toThrow('seed failed');
    h.connect.mockRejectedValueOnce(new Error('cleanup connection failed'));
    await expect(h.teardown.mock.calls[0][0]()).rejects.toThrow('cleanup connection failed');
    expect(h.Client).toHaveBeenCalledTimes(2);
    expect(h.connect).toHaveBeenCalledTimes(2);
    expect(h.query.mock.calls).toEqual([['TRUNCATE store CASCADE']]);
    expect(h.end).toHaveBeenCalledTimes(2);
  });

  it('cleans a partial seed only on the validated target even if the environment changes', async () => {
    const databaseUrl = 'postgres://localhost/shop_test';
    const h = fixture(databaseUrl);
    await h.load();
    h.query.mockRejectedValueOnce(new Error('seed failed'));
    await expect(h.setup.mock.calls[0][0]()).rejects.toThrow('seed failed');
    expect(h.end).toHaveBeenCalledTimes(1);
    vi.stubEnv('DATABASE_URL', 'postgres://localhost/production');
    await h.teardown.mock.calls[0][0]();
    expect(h.Client.mock.calls).toEqual([
      [{ connectionString: databaseUrl }], [{ connectionString: databaseUrl }],
    ]);
    expect(h.query.mock.calls).toEqual([
      ['TRUNCATE store CASCADE'], ['TRUNCATE store CASCADE'],
      ['DROP TABLE IF EXISTS sample_note'], ['DROP TABLE IF EXISTS drizzle.__drizzle_migrations_sample'],
    ]);
    expect(h.end).toHaveBeenCalledTimes(2);
  });
});
