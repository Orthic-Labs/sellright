/**
 * DB tests for checkout legal acceptance (ported upstream from RightSites'
 * packages/api/src/legal + the checkout.ts wiring delta; SellRight resolves
 * manifests per-store from store.config.legalManifests instead of committed
 * suite JSON — suite manifest data stays downstream).
 *
 * Runs against sr_legal_test ONLY (these wipe data). Mirrors
 * checkout.route.test.ts conventions: withStore seeds, x-store-slug header,
 * TRUNCATE store CASCADE wipe. vitest runs files serially.
 *
 * Covers:
 *   1. valid acceptance on a manifest-configured licensed product → order +
 *      immutable receipt in order.metadata.legal_acceptance (re-read proves
 *      the stored doc ids/versions/hashes are the configured ones)
 *   2. missing acceptance on a configured product → 422
 *   3. products with NO configured manifest (digital + licensed-but-
 *      unconfigured appKey) → unaffected, no receipt
 *   4. tampered document version/hash → 422, no order
 *   5. Idempotency-Key replay → same order, same receipt
 *   6. cart-token path (expectedRevision contract) still works with acceptance
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq, sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';
import { clearLoginAttempts } from '../auth/rate-limit.js';
import type { LegalManifest } from '@rightkit/legal';
import { checkout } from './checkout.js';
import { cart } from './cart.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`checkout-legal test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'bbbbbbbb-2222-2222-2222-222222222222';
const SLUG = 'checkout-legal-test-store';
const PRODUCT = 'bbbbbbbb-2222-2222-2222-2222222222a1';
const VARIANT_LIC = 'bbbbbbbb-2222-2222-2222-2222222222b1';
const VARIANT_UNCONF = 'bbbbbbbb-2222-2222-2222-2222222222b2';
const VARIANT_DIG = 'bbbbbbbb-2222-2222-2222-2222222222b3';
const SKU_LIC = 'LEGAL-LIC-1';       // license + appKey 'testapp' (manifest configured)
const SKU_UNCONF = 'LEGAL-LIC-2';    // license + appKey with NO configured manifest
const SKU_DIG = 'LEGAL-DIG-1';       // ordinary digital product
const PRICE = 4900;

function fixtureManifest(appKey = 'testapp'): LegalManifest {
  const doc = (role: string, treatment: string, material: boolean, over: Record<string, unknown> = {}) => ({
    id: `${appKey}-${role}`,
    role,
    title: `${appKey} ${role}`,
    version: '1.0',
    sha256: 'a'.repeat(64),
    path: `${role.toUpperCase()}.md`,
    publicUrl: `https://${appKey}.example.com/legal/${role}/`,
    treatment,
    material,
    ...over,
  });
  return {
    schema: 2,
    suite: 'right-suite-desktop',
    appKey,
    productName: 'TestApp',
    licensor: 'Test Co',
    effectiveDate: '2026-08-01',
    acceptanceVersion: `${appKey}-2026-08-01-v1`,
    documents: [
      doc('license', 'agree', true),
      doc('eula', 'agree', true),
      doc('acceptable_use', 'agree', true),
      doc('product_schedule', 'agree', true),
      doc('privacy_notice', 'acknowledge', false),
      doc('third_party_notices', 'notice', false),
    ],
  } as LegalManifest;
}

const MANIFEST = fixtureManifest();

/** The wire payload a storefront submits — echoes the configured manifest. */
function acceptanceFor(manifest: LegalManifest, over: Record<string, unknown> = {}) {
  return {
    acceptanceVersion: manifest.acceptanceVersion,
    eligibilityBasis: 'individual',
    authorityConfirmed: true,
    agreementStatement: 'I agree to the license terms.',
    documents: manifest.documents
      .filter((d) => d.role !== 'third_party_notices')
      .map((d) => ({ role: d.role, id: d.id, version: d.version, sha256: d.sha256, url: d.publicUrl, treatment: d.treatment })),
    ...over,
  };
}

const app = new OpenAPIHono();
app.route('/', checkout);
app.route('/', cart);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
}

async function seed(): Promise<void> {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, tax_rate, config)
      VALUES (${STORE}, ${SLUG}, ${SLUG}, 'USD', 0, ${JSON.stringify({ legalManifests: { testapp: MANIFEST } })}::jsonb)
      ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (${PRODUCT}, ${STORE}, 'legal-prod', 'Legal Product', 'active') ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price, fulfillment_type, app_key)
      VALUES (${VARIANT_LIC}, ${STORE}, ${PRODUCT}, ${SKU_LIC}, 'TestApp License', ${PRICE}, 'license', 'testapp') ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price, fulfillment_type, app_key)
      VALUES (${VARIANT_UNCONF}, ${STORE}, ${PRODUCT}, ${SKU_UNCONF}, 'Unconfigured License', ${PRICE}, 'license', 'unconfigured-app') ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price, fulfillment_type)
      VALUES (${VARIANT_DIG}, ${STORE}, ${PRODUCT}, ${SKU_DIG}, 'Plain Download', ${PRICE}, 'digital_download') ON CONFLICT (id) DO NOTHING`);
    for (const v of [VARIANT_LIC, VARIANT_UNCONF, VARIANT_DIG]) {
      await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated) VALUES (${v}, ${STORE}, 10, 0) ON CONFLICT (variant_id) DO UPDATE SET on_hand = 10, allocated = 0`);
    }
  });
}

beforeEach(async () => {
  clearLoginAttempts('unknown', 'checkout:unknown');
  await wipe();
  await seed();
});
afterAll(async () => { await wipe(); await pool.end(); });

const hdr = (extra: Record<string, string> = {}) => ({ 'content-type': 'application/json', 'x-store-slug': SLUG, ...extra });

function post(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return app.request('/v1/shop/checkout', { method: 'POST', headers: hdr(headers), body: JSON.stringify(body) });
}

interface StoredReceipt {
  app_key: string;
  acceptance_version: string;
  accepted_via: string;
  documents: Array<{ role: string; id: string; version: string; sha256: string; url: string }>;
}

async function receiptByCode(code: string): Promise<StoredReceipt | null> {
  return withStore(STORE, async (tx) => {
    const [o] = await tx.select({ metadata: s.order.metadata }).from(s.order).where(eq(s.order.code, code)).limit(1);
    return ((o?.metadata as { legal_acceptance?: StoredReceipt } | null)?.legal_acceptance) ?? null;
  });
}

describe('POST /v1/shop/checkout — legal acceptance', () => {
  it('valid acceptance creates the order and persists an immutable receipt (re-read proves stored docs)', async () => {
    const res = await post({ items: [{ sku: SKU_LIC, quantity: 1 }], email: 'buyer@example.com', legalAcceptance: acceptanceFor(MANIFEST) });
    expect(res.status).toBe(200);
    const body = await res.json() as { code: string };

    const receipt = await receiptByCode(body.code);
    expect(receipt).not.toBeNull();
    expect(receipt!.app_key).toBe('testapp');
    expect(receipt!.acceptance_version).toBe(MANIFEST.acceptanceVersion);
    expect(receipt!.accepted_via).toBe('checkout');
    // The receipt stores the CONFIGURED manifest's documents byte-for-byte:
    // all five checkout roles with their canonical ids/versions/hashes/urls.
    expect(receipt!.documents).toHaveLength(5);
    for (const d of receipt!.documents) {
      const canonical = MANIFEST.documents.find((m) => m.role === d.role)!;
      expect(d.id).toBe(canonical.id);
      expect(d.version).toBe(canonical.version);
      expect(d.sha256).toBe(canonical.sha256);
      expect(d.url).toBe(canonical.publicUrl);
    }
    expect(receipt!.documents.some((d) => d.role === 'third_party_notices')).toBe(false);
  });

  it('missing legalAcceptance on a manifest-configured product → 422 and no order', async () => {
    const res = await post({ items: [{ sku: SKU_LIC, quantity: 1 }] });
    expect(res.status).toBe(422);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/legal acceptance/i);
    const n = await withStore(STORE, async (tx) => {
      const r = await tx.execute(sql`SELECT count(*)::int n FROM "order" WHERE store_id = ${STORE}`);
      return (r.rows[0] as { n: number }).n;
    });
    expect(n).toBe(0);
  });

  it('products with no configured manifest are unaffected — no acceptance, no receipt', async () => {
    // Ordinary digital product: zero behavior change.
    const dig = await post({ items: [{ sku: SKU_DIG, quantity: 1 }] });
    expect(dig.status).toBe(200);
    const digBody = await dig.json() as { code: string };
    expect(await receiptByCode(digBody.code)).toBeNull();

    // A LICENSED product whose appKey has no configured manifest: not opted in.
    const unconf = await post({ items: [{ sku: SKU_UNCONF, quantity: 1 }] });
    expect(unconf.status).toBe(200);
    const unconfBody = await unconf.json() as { code: string };
    expect(await receiptByCode(unconfBody.code)).toBeNull();
  });

  it('tampered document version or sha256 → 422 (client claims are never trusted)', async () => {
    const tamperedVersion = acceptanceFor(MANIFEST);
    tamperedVersion.documents[0]!.version = '9.9';
    const resV = await post({ items: [{ sku: SKU_LIC, quantity: 1 }], legalAcceptance: tamperedVersion });
    expect(resV.status).toBe(422);

    const tamperedHash = acceptanceFor(MANIFEST);
    tamperedHash.documents[0]!.sha256 = 'b'.repeat(64);
    const resH = await post({ items: [{ sku: SKU_LIC, quantity: 1 }], legalAcceptance: tamperedHash });
    expect(resH.status).toBe(422);

    const wrongVersion = acceptanceFor(MANIFEST, { acceptanceVersion: 'testapp-1999-01-01-v0' });
    const resA = await post({ items: [{ sku: SKU_LIC, quantity: 1 }], legalAcceptance: wrongVersion });
    expect(resA.status).toBe(422);
  });

  it('Idempotency-Key replay returns the same order AND the same stored receipt', async () => {
    const key = 'legal-idem-1';
    const payload = { items: [{ sku: SKU_LIC, quantity: 1 }], email: 'buyer@example.com', legalAcceptance: acceptanceFor(MANIFEST) };
    const first = await post(payload, { 'idempotency-key': key });
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { code: string };

    const second = await post(payload, { 'idempotency-key': key });
    expect(second.status).toBe(200);
    const secondBody = await second.json() as { code: string };
    expect(secondBody.code).toBe(firstBody.code);

    const [r1, r2] = await Promise.all([receiptByCode(firstBody.code), receiptByCode(secondBody.code)]);
    expect(r2).toEqual(r1);

    const n = await withStore(STORE, async (tx) => {
      const r = await tx.execute(sql`SELECT count(*)::int n FROM "order" WHERE idempotency_key = ${key}`);
      return (r.rows[0] as { n: number }).n;
    });
    expect(n).toBe(1);
  });

  it('cart-token path: expectedRevision contract is unchanged and acceptance still enforced', async () => {
    // Missing expectedRevision → 409 revision_required (pre-existing contract).
    const cartRes = await app.request('/v1/shop/cart', { method: 'POST', headers: hdr(), body: JSON.stringify({ items: [{ sku: SKU_LIC, quantity: 1 }] }) });
    expect(cartRes.status).toBe(200);
    const { token, revision } = await cartRes.json() as { token: string; revision: number };

    // (items is schema-required min(1) even on the cartToken path — the server
    // ignores it there and derives lines from the cart itself.)
    const noRev = await post({ items: [{ sku: SKU_LIC, quantity: 1 }], cartToken: token, legalAcceptance: acceptanceFor(MANIFEST) });
    expect(noRev.status).toBe(409);

    // Correct revision but no acceptance → 422 (acceptance checked before convert).
    const noAccept = await post({ items: [{ sku: SKU_LIC, quantity: 1 }], cartToken: token, expectedRevision: revision });
    expect(noAccept.status).toBe(422);

    // Correct revision + valid acceptance → 200 with receipt.
    const ok = await post({ items: [{ sku: SKU_LIC, quantity: 1 }], cartToken: token, expectedRevision: revision, legalAcceptance: acceptanceFor(MANIFEST) });
    expect(ok.status).toBe(200);
    const okBody = await ok.json() as { code: string };
    expect(await receiptByCode(okBody.code)).not.toBeNull();
  });
});
