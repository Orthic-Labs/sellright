/**
 * DB-layer tests for the generic license lifecycle (de-fork Phase 5):
 *   - revoke flips the license and cascades to every active activation (tombstone,
 *     generation bump); already-tombstoned activations are untouched
 *   - revoke is idempotent; restore does not reactivate cascaded activations
 *   - restore refuses an expired licence; cross-tenant revoke is notfound
 *   - the revocation feed is tenant-bound and lists only revoked ids of its tenant
 *   - runtime artifact selection: identity selectors, exact over any/any,
 *     ambiguity fails closed, lane scoping by entitlement tier
 *
 * Runs against a *_test database (TRUNCATEs). vitest runs DB files serially.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';
import { licenseLifecycle } from './license-revocation.js';
import { createLicenseRevocationFeed } from './revocation-feed.js';
import { resolveRuntimeArtifactPromotion } from './runtime-artifact-resolve.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`license-lifecycle test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const STORE_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const DIGEST = 'a'.repeat(64);

async function seedStore(id: string) {
  await pool.query('INSERT INTO store (id, slug, name) VALUES ($1, $2, $2) ON CONFLICT (id) DO NOTHING', [id, id]);
}

async function seedLicense(storeId: string, opts: { status?: string; expiresAt?: Date | null; key?: string } = {}): Promise<string> {
  const id = crypto.randomUUID();
  await withStore(storeId, (tx) => tx.insert(s.license).values({
    id, storeId, appKey: 'testapp', licenseKey: opts.key ?? `KEY-${id}`,
    status: (opts.status ?? 'active') as 'active',
    expiresAt: opts.expiresAt ?? null,
  }));
  return id;
}

async function seedActivation(storeId: string, licenseId: string, state = 'active', generation = 0): Promise<string> {
  const id = crypto.randomUUID();
  await withStore(storeId, (tx) => tx.insert(s.licenseActivation).values({
    id, storeId, licenseId, appKey: 'testapp', deviceIdHash: `dev-${id}`, state, generation,
  }));
  return id;
}

async function activationRow(storeId: string, id: string) {
  return withStore(storeId, async (tx) => {
    const [row] = await tx.select().from(s.licenseActivation).where(sql`id = ${id}`);
    return row;
  });
}

async function licenseStatus(storeId: string, id: string) {
  return withStore(storeId, async (tx) => {
    const [row] = await tx.select({ status: s.license.status }).from(s.license).where(sql`id = ${id}`);
    return row?.status;
  });
}

async function seedPromotion(storeId: string, p: {
  artifactId: string | null; os: string; arch: string; delivery?: string; kind?: string; pointerKey?: string; appKey?: string;
}): Promise<string> {
  const id = crypto.randomUUID();
  await withStore(storeId, (tx) => tx.insert(s.runtimeArtifactPromotion).values({
    id, storeId,
    appKey: p.appKey ?? 'testapp',
    artifactKind: p.kind ?? 'ocr-model',
    artifactId: p.artifactId,
    targetOs: p.os,
    targetArch: p.arch,
    delivery: p.delivery ?? 'private-r2',
    pointerKey: p.pointerKey ?? `testapp/runtime-artifacts/${p.kind ?? 'ocr-model'}/${p.artifactId ? `${p.artifactId}/` : ''}${p.os}/${p.arch}/current/manifest.json`,
    objectSha256: DIGEST,
    envelopeSha256: DIGEST,
    signingKeyId: 'k1',
    promotionId: `promo-${id}`,
    envelope: { manifest: {} },
    promotedAt: new Date('2026-07-14T12:00:00.000Z'),
  }));
  return id;
}

beforeEach(async () => {
  await pool.query('TRUNCATE store CASCADE');
  await seedStore(STORE_A);
  await seedStore(STORE_B);
});

afterAll(async () => {
  await pool.end().catch(() => undefined);
});

describe('license lifecycle: revoke / restore', () => {
  it('revoke cascades to active activations only and bumps their generation', async () => {
    const lic = await seedLicense(STORE_A);
    const a1 = await seedActivation(STORE_A, lic, 'active', 2);
    const a2 = await seedActivation(STORE_A, lic, 'active', 0);
    const gone = await seedActivation(STORE_A, lic, 'removed', 5);

    const out = await licenseLifecycle.revoke(STORE_A, lic, { actor: 'ops@example.test', reason: 'refund' });
    expect(out).toMatchObject({ kind: 'ok', status: 'revoked', changed: true });
    expect(await licenseStatus(STORE_A, lic)).toBe('revoked');

    const r1 = await activationRow(STORE_A, a1);
    expect(r1).toMatchObject({ state: 'revoked', generation: 3 });
    expect(r1?.revokedAt).toBeInstanceOf(Date);
    expect(await activationRow(STORE_A, a2)).toMatchObject({ state: 'revoked', generation: 1 });
    expect(await activationRow(STORE_A, gone)).toMatchObject({ state: 'removed', generation: 5 });
  });

  it('revoke is idempotent and writes one audit row', async () => {
    const lic = await seedLicense(STORE_A);
    await seedActivation(STORE_A, lic);
    await licenseLifecycle.revoke(STORE_A, lic, { actor: 'ops' });
    const again = await licenseLifecycle.revoke(STORE_A, lic, { actor: 'ops' });
    expect(again).toMatchObject({ kind: 'ok', changed: false, revokedActivationIds: [] });
    const audits = await withStore(STORE_A, (tx) => tx.select().from(s.auditLog).where(sql`entity_id = ${lic} AND action = 'revoke'`));
    expect(audits).toHaveLength(1);
  });

  it('restore reactivates the licence but never its cascaded activations', async () => {
    const lic = await seedLicense(STORE_A);
    const act = await seedActivation(STORE_A, lic);
    await licenseLifecycle.revoke(STORE_A, lic, { actor: 'ops' });
    const out = await licenseLifecycle.restore(STORE_A, lic, { actor: 'ops' });
    expect(out).toMatchObject({ kind: 'ok', status: 'active', changed: true });
    expect(await licenseStatus(STORE_A, lic)).toBe('active');
    expect(await activationRow(STORE_A, act)).toMatchObject({ state: 'revoked' });
  });

  it('restore refuses an expired licence and leaves it revoked', async () => {
    const lic = await seedLicense(STORE_A, { expiresAt: new Date('2020-01-01T00:00:00.000Z') });
    await withStore(STORE_A, (tx) => tx.update(s.license).set({ status: 'revoked' }).where(sql`id = ${lic}`));
    const out = await licenseLifecycle.restore(STORE_A, lic, { actor: 'ops' });
    expect(out).toEqual({ kind: 'refused', reason: 'expired' });
    expect(await licenseStatus(STORE_A, lic)).toBe('revoked');
  });

  it('is tenant-scoped: another store cannot revoke or restore the licence', async () => {
    const lic = await seedLicense(STORE_A);
    expect(await licenseLifecycle.revoke(STORE_B, lic, { actor: 'ops' })).toEqual({ kind: 'notfound' });
    expect(await licenseStatus(STORE_A, lic)).toBe('active');
    expect(await licenseLifecycle.restore(STORE_B, lic, { actor: 'ops' })).toEqual({ kind: 'notfound' });
  });
});

describe('tenant-bound revocation feed', () => {
  it('lists only revoked ids of the resolved tenant', async () => {
    const mine = await seedLicense(STORE_A);
    await seedLicense(STORE_A); // active, not listed
    const theirs = await seedLicense(STORE_B);
    await licenseLifecycle.revoke(STORE_A, mine, { actor: 'ops' });
    await licenseLifecycle.revoke(STORE_B, theirs, { actor: 'ops' });

    const app = createLicenseRevocationFeed({ resolveTenant: async () => ({ id: STORE_A }) });
    const res = await app.request('/v1/pro/revocations');
    const body = await res.json() as { ids: string[]; updatedAt: string };
    expect(body.ids).toEqual([mine]);
    expect(Object.keys(body)).toEqual(['ids', 'updatedAt']);
  });
});

describe('runtime artifact selection', () => {
  it('selects by identity, prefers exact target over any/any, and fails closed on ambiguity', async () => {
    const wild = await seedPromotion(STORE_A, { artifactId: 'ocr-main', os: 'any', arch: 'any' });
    const exact = await seedPromotion(STORE_A, { artifactId: 'ocr-main', os: 'darwin', arch: 'aarch64' });
    const run = (artifact: string, os: string, arch: string) => withStore(STORE_A, (tx) => resolveRuntimeArtifactPromotion(tx, {
      storeId: STORE_A, appKey: 'testapp', selector: { artifactId: artifact }, target: { os, arch }, entitlementTier: 'pro',
    }));
    expect(await run('ocr-main', 'darwin', 'aarch64')).toMatchObject({ kind: 'ok', promotion: { id: exact } });
    expect(await run('ocr-main', 'linux', 'x86_64')).toMatchObject({ kind: 'ok', promotion: { id: wild } });
    // Same identity on a second kind at the same target is ambiguous under the same selector: fail closed.
    await seedPromotion(STORE_A, { artifactId: 'ocr-main', os: 'any', arch: 'any', kind: 'tokenizer' });
    expect(await run('ocr-main', 'linux', 'x86_64')).toEqual({ kind: 'notfound' });
  });

  it('scopes lanes by entitlement tier and keeps legacy (NULL identity) selectors working', async () => {
    const pub = await seedPromotion(STORE_A, { artifactId: null, os: 'linux', arch: 'x86_64', delivery: 'public-r2', kind: 'preprocessing' });
    const legacy = await seedPromotion(STORE_A, { artifactId: null, os: 'linux', arch: 'x86_64', kind: 'ocr-model' });
    const pointer = `testapp/runtime-artifacts/ocr-model/linux/x86_64/current/manifest.json`;
    const resolve = (selector: { artifact: string }, tier: 'pro' | 'public') => withStore(STORE_A, (tx) => resolveRuntimeArtifactPromotion(tx, {
      storeId: STORE_A, appKey: 'testapp', selector, target: { os: 'linux', arch: 'x86_64' }, entitlementTier: tier,
    }));
    expect(await resolve({ artifact: pointer }, 'pro')).toMatchObject({ kind: 'ok', promotion: { id: legacy } });
    expect(await resolve({ artifact: pointer }, 'public')).toEqual({ kind: 'notfound' });
    // A public-lane row resolves for both tiers via its row UUID (pro includes public-r2).
    expect(await resolve({ artifact: pub }, 'public')).toMatchObject({ kind: 'ok', promotion: { id: pub } });
    expect(await resolve({ artifact: pub }, 'pro')).toMatchObject({ kind: 'ok', promotion: { id: pub } });
  });
});
