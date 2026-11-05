/**
 * ADR-0001 I-4 / QS-6: every maintenance toggle purges every host of the store, after the flag write, with retry +
 * alert, never throwing; and toggleMaintenance() is the only code path that flips the flag.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { envMock, errError, logInfo } = vi.hoisted(() => ({ envMock: {} as Record<string, string | undefined>, errError: vi.fn(), logInfo: vi.fn() }));
vi.mock('./env.js', () => ({ env: envMock }));
vi.mock('./lib/logger.js', () => ({ log: { info: (...a: unknown[]) => logInfo(...a) }, err: { error: (...a: unknown[]) => errError(...a) } }));

import { toggleMaintenance } from './maintenance-toggle.js';
import { isMaintenanceOn } from './maintenance.js';
import { _setPurgeRetryPolicyForTest, PURGE_MAX_ATTEMPTS } from './cache/purge-hook.js';

const TOKEN = 'cf-secret-token-never-logged';
// rightsites shape: 7 hosts over 5 zones.
const HOSTS = ['store.rightsites.app', 'shop.a.com', 'www.a.com', 'b.com', 'www.b.com', 'c.com', 'd.com'];
const ZONES: Record<string, string> = { 'store.rightsites.app': 'z-rs', 'shop.a.com': 'z-a', 'www.a.com': 'z-a', 'b.com': 'z-b', 'www.b.com': 'z-b', 'c.com': 'z-c', 'd.com': 'z-d' };

const fetchMock = vi.fn();
let dir: string;

beforeEach(() => {
  for (const k of Object.keys(envMock)) delete envMock[k];
  dir = mkdtempSync(join(tmpdir(), 'maint-toggle-'));
  Object.assign(envMock, {
    MAINTENANCE_FLAG_FILE: join(dir, 'state', 'MAINTENANCE'),
    STORE_SLUG: 'rs',
    STOREFRONT_URL: 'https://store.rightsites.app',
    STOREFRONT_HOSTS_BY_STORE: `rs=${HOSTS.join('|')}`,
    CLOUDFLARE_ZONE_ID_BY_HOST: Object.entries(ZONES).map(([h, z]) => `${h}=${z}`).join(','),
    CLOUDFLARE_API_TOKEN: TOKEN,
  });
  errError.mockClear(); logInfo.mockClear();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  _setPurgeRetryPolicyForTest({ attemptTimeoutMs: 50, backoffBaseMs: 1 });
});
afterEach(() => {
  vi.unstubAllGlobals();
  _setPurgeRetryPolicyForTest();
  rmSync(dir, { recursive: true, force: true });
});

const purgedHostsByZone = () => {
  const out: Record<string, string[]> = {};
  for (const [url, init] of fetchMock.mock.calls as [string, RequestInit][]) {
    const zone = /zones\/([^/]+)\/purge_cache/.exec(url)![1]!;
    const body = JSON.parse(String(init.body)) as { hosts?: string[]; files?: string[] };
    expect(body.files).toBeUndefined();
    (out[zone] ??= []).push(...body.hosts!);
  }
  return out;
};

describe('toggleMaintenance', () => {
  it.each([true, false])('on=%s writes the flag, then host-purges all 7 hosts across 5 zones', async (on) => {
    if (!on) await toggleMaintenance(true);
    fetchMock.mockClear();
    const flagAtPurge: boolean[] = [];
    fetchMock.mockImplementation(async () => { flagAtPurge.push(isMaintenanceOn()); return new Response(JSON.stringify({ success: true }), { status: 200 }); });
    await expect(toggleMaintenance(on, { reason: 'update' })).resolves.toBe('purged');
    expect(isMaintenanceOn()).toBe(on);
    expect(flagAtPurge.length).toBe(5);
    expect(flagAtPurge.every((f) => f === on)).toBe(true); // purge runs after the flag write
    const byZone = purgedHostsByZone();
    expect(Object.keys(byZone).sort()).toEqual(['z-a', 'z-b', 'z-c', 'z-d', 'z-rs']);
    expect(Object.values(byZone).flat().sort()).toEqual([...HOSTS].sort());
  });

  it('retries a failing purge, then alerts once and resolves failed — never throws, flag stays written', async () => {
    fetchMock.mockImplementation(async () => { throw new Error('network down'); });
    await expect(toggleMaintenance(true)).resolves.toBe('failed');
    expect(isMaintenanceOn()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(5 * PURGE_MAX_ATTEMPTS);
    const alerts = errError.mock.calls.filter((c) => (c[2] as { alert?: string } | undefined)?.alert === 'cache_purge_failed');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]![2]).toMatchObject({ event: 'maintenance', storeSlug: 'rs', mode: 'host' });
  });

  it('never logs the Cloudflare token', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ success: false, errors: [{ code: 10000 }] }), { status: 403 }));
    await toggleMaintenance(true);
    expect(JSON.stringify([...errError.mock.calls, ...logInfo.mock.calls], (_k, v: unknown) => (v instanceof Error ? v.message : v))).not.toContain(TOKEN);
  });

  it('without a store slug still flips the flag and raises the purge alert', async () => {
    delete envMock.STORE_SLUG;
    await expect(toggleMaintenance(true)).resolves.toBe('failed');
    expect(isMaintenanceOn()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errError.mock.calls[0]![2]).toMatchObject({ alert: 'cache_purge_failed', event: 'maintenance' });
  });
});

describe('every maintenance toggle path goes through toggleMaintenance', () => {
  const root = fileURLToPath(new URL('.', import.meta.url));
  const files = (d: string): string[] => readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') && !/\.test\.ts$|\.testkit\.ts$/.test(p) ? [p] : [];
  });
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('setMaintenance() / the flag file are written only by maintenance.ts and maintenance-toggle.ts', () => {
    const offenders = files(root)
      .map((p) => [relative(root, p), strip(readFileSync(p, 'utf8'))] as const)
      .filter(([rel, code]) => rel !== 'maintenance.ts' && rel !== 'maintenance-toggle.ts'
        && (/\bsetMaintenance\b/.test(code) || /\bmaintenanceFlagPath\s*\(/.test(code) || /MAINTENANCE_FLAG_FILE/.test(code) && /\b(writeFileSync|rmSync|unlinkSync|writeFile|rm|unlink)\s*\(/.test(code)))
      .map(([rel]) => rel);
    expect(offenders).toEqual([]);
  });
});
