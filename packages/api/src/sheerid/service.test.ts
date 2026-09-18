/**
 * PAR-04 tests — provider adapter runs against an injected mock transport
 * (no network); the lifecycle functions run DB-gated against the *_test db.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { SheerIdClient, sheeridConfig } from './provider.js';
import {
  applyVerificationDetails, fetchVerificationDetails, recomputeCustomerVerifications,
  revokeVerification, startVerification, sweepExpiredVerifications,
  type SheerIdVerificationDetails,
} from './service.js';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';

const CFG = {
  programId: 'prog-1',
  theme: 'theme-9',
  clientId: 'cid',
  clientSecret: 'csecret',
  webhookSecret: 'whsec',
  verificationTtlDays: 30,
};

/** Mock SheerID transport: token endpoint + details endpoint. */
function mockTransport(details: SheerIdVerificationDetails) {
  const calls: string[] = [];
  const transport = async (url: string, _init: RequestInit): Promise<Response> => {
    calls.push(url);
    if (url.includes('/oauth/token')) {
      return new Response(JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }), { status: 200 });
    }
    return new Response(JSON.stringify(details), { status: 200 });
  };
  return { transport, calls };
}

describe('SheerIdClient (mocked transport)', () => {
  const details: SheerIdVerificationDetails = {
    verificationId: 'vid-1',
    lastResponse: { currentStep: 'success', segment: 'military' },
    personInfo: { metadata: { customerId: 'cust-1' } },
  };

  it('fetches a token then verification details, caching the token', async () => {
    const { transport, calls } = mockTransport(details);
    const client = new SheerIdClient(CFG, transport);
    const d1 = await client.getVerificationDetails('vid-1');
    const d2 = await client.getVerificationDetails('vid-2');
    expect(d1.verificationId).toBe('vid-1');
    expect(d2.verificationId).toBe('vid-1'); // mock returns same body; call happened
    // token endpoint hit ONCE across two detail calls (client caches it)
    expect(calls.filter((u) => u.includes('/oauth/token'))).toHaveLength(1);
    expect(calls.filter((u) => u.includes('/rest/v2/verification/'))).toHaveLength(2);
  });

  it('fails closed without client credentials', async () => {
    const client = new SheerIdClient({ programId: 'p' }, async () => new Response('{}', { status: 200 }));
    await expect(client.getVerificationDetails('x')).rejects.toThrow('not configured');
  });

  it('verificationUrl carries program, theme and customerId metadata', async () => {
    const url = new SheerIdClient(CFG).verificationUrl('prog-1', 'cust-42');
    expect(url).toContain('/verify/prog-1/');
    expect(url).toContain('theme=theme-9');
    expect(decodeURIComponent(url)).toContain('"customerId":"cust-42"');
  });

  it('fetchVerificationDetails goes through the injected transport', async () => {
    const { transport } = mockTransport(details);
    const d = await fetchVerificationDetails(CFG, 'vid-9', transport);
    expect(d.verificationId).toBe('vid-1');
  });

  it('sheeridConfig reads store.config.sheerid only', () => {
    expect(sheeridConfig({ sheerid: CFG })).toEqual(CFG);
    expect(sheeridConfig({})).toBeNull();
    expect(sheeridConfig(null)).toBeNull();
  });
});

// ── DB-gated lifecycle ───────────────────────────────────────────────────────
const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
const isTestDb = /_test(\b|$|\?)/.test(DB);
const STORE = '66666666-6666-6666-6666-666666666666';

async function wipe() { await pool.query('TRUNCATE store CASCADE'); }

async function seed(): Promise<string> {
  await pool.query(`INSERT INTO store (id, slug, name, currency, config) VALUES ($1, 'sheerid-test', 'SheerID Test', 'USD', $2::jsonb)`, [STORE, JSON.stringify({ sheerid: CFG })]);
  const r = await withStore(STORE, (tx) => tx.execute(sql`
    INSERT INTO customer (id, store_id, email) VALUES (gen_random_uuid(), ${STORE}, 'vet@x.test') RETURNING id`));
  return (r.rows[0] as { id: string }).id;
}

const activeOf = (customerId: string) => withStore(STORE, async (tx) => {
  const r = await tx.execute(sql`SELECT active_verifications AS a FROM customer WHERE id = ${customerId}`);
  return ((r.rows[0] as { a: string[] | null }).a) ?? [];
});
const rowCount = () => withStore(STORE, async (tx) => {
  const r = await tx.execute(sql`SELECT count(*)::int AS n FROM sheerid_verification`);
  return (r.rows[0] as { n: number }).n;
});

function successDetails(customerId: string, vid = 'vid-db-1'): SheerIdVerificationDetails {
  return {
    verificationId: vid,
    lastResponse: { currentStep: 'success', segment: 'military' },
    personInfo: { metadata: { customerId } },
  };
}

describe.skipIf(!isTestDb)('sheerid lifecycle — DB integration', () => {
  beforeEach(wipe);
  afterAll(wipe);

  it('start → apply(success) grants the category and flips coupon eligibility; revoke strips it', async () => {
    const customerId = await seed();
    const { id } = await withStore(STORE, (tx) => startVerification(tx, STORE, customerId, 'prog-1'));
    expect(await rowCount()).toBe(1);

    const res = await withStore(STORE, (tx) => applyVerificationDetails(tx, STORE, successDetails(customerId), sheeridConfig({ sheerid: CFG })));
    expect(res.outcome).toBe('verified');
    expect(res.category).toBe('military');
    expect(await activeOf(customerId)).toEqual(['military']);

    // Idempotent redelivery — same verificationId returns recorded outcome, no rewrite.
    const again = await withStore(STORE, (tx) => applyVerificationDetails(tx, STORE, successDetails(customerId), sheeridConfig({ sheerid: CFG })));
    expect(again.outcome).toBe('verified');
    expect(again.reason).toBe('duplicate delivery');
    expect(await rowCount()).toBe(1); // the pending row was patched in place

    const rev = await withStore(STORE, (tx) => revokeVerification(tx, STORE, { customerId, category: 'military' }, 'ops@x.test'));
    expect(rev.revoked).toBe(1);
    expect(await activeOf(customerId)).toEqual([]); // coupon eligibility gone
    void id;
  });

  it('unmapped segment / failed step never grants eligibility', async () => {
    const customerId = await seed();
    const res = await withStore(STORE, (tx) => applyVerificationDetails(tx, STORE, {
      verificationId: 'vid-x',
      lastResponse: { currentStep: 'success', segment: 'unmapped_segment' },
      personInfo: { metadata: { customerId } },
    }, sheeridConfig({ sheerid: CFG })));
    expect(res.outcome).toBe('failed'); // unknown segment fails closed
    expect(await activeOf(customerId)).toEqual([]);

    const res2 = await withStore(STORE, (tx) => applyVerificationDetails(tx, STORE, {
      verificationId: 'vid-y',
      lastResponse: { currentStep: 'error', segment: 'military' },
      personInfo: { metadata: { customerId } },
    }, sheeridConfig({ sheerid: CFG })));
    expect(res2.outcome).toBe('failed');
    expect(await activeOf(customerId)).toEqual([]);
  });

  it('expiry sweep flips stale rows and drops the category', async () => {
    const customerId = await seed();
    await withStore(STORE, (tx) => applyVerificationDetails(tx, STORE, successDetails(customerId), sheeridConfig({ sheerid: CFG })));
    expect(await activeOf(customerId)).toEqual(['military']);

    // Age the row past expiry, then sweep.
    await withStore(STORE, (tx) => tx.execute(sql`UPDATE sheerid_verification SET expires_at = now() - interval '1 day'`));
    const res = await withStore(STORE, (tx) => sweepExpiredVerifications(tx, STORE));
    expect(res.expired).toBe(1);
    expect(await activeOf(customerId)).toEqual([]);
  });

  it('imported legacy jsonb verifications survive recompute until their own expiry', async () => {
    const customerId = await seed();
    await withStore(STORE, (tx) => tx.execute(sql`
      UPDATE customer SET
        sheerid_verifications = ${JSON.stringify([{ programId: 'legacy', category: 'student', verificationId: null, status: 'verified', discountPercent: 15, verifiedAt: '2020-01-01T00:00:00Z', expiresAt: '2999-01-01T00:00:00Z' }])}::jsonb,
        active_verifications = ARRAY['student']`));
    const active = await withStore(STORE, (tx) => recomputeCustomerVerifications(tx, STORE, customerId));
    expect(active).toEqual(['student']); // no backing row — but preserved

    // Now expire the legacy entry — recompute drops it.
    await withStore(STORE, (tx) => tx.execute(sql`
      UPDATE customer SET
        sheerid_verifications = ${JSON.stringify([{ programId: 'legacy', category: 'student', verificationId: null, status: 'verified', discountPercent: 15, verifiedAt: '2020-01-01T00:00:00Z', expiresAt: '2000-01-01T00:00:00Z' }])}::jsonb`));
    const active2 = await withStore(STORE, (tx) => recomputeCustomerVerifications(tx, STORE, customerId));
    expect(active2).toEqual([]);
  });
});
