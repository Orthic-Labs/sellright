import { isDisposablePostgresUrl } from '../db/test-database-url.js';
import { createHmac } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { sql } from 'drizzle-orm';
import { invalidateStoreCache } from '../store-context.js';
import { legacyContactMarkerId } from './contact-legacy.js';

const failure = vi.hoisted(() => ({ ack: false }));
vi.mock('../email/outbox.js', async (original) => {
  const actual = await original<typeof import('../email/outbox.js')>();
  return { ...actual, enqueueEmail: async (...args: Parameters<typeof actual.enqueueEmail>) => {
    if (failure.ack && args[2].kind === 'contact_ack') throw new Error('fixture: ack enqueue failed');
    return actual.enqueueEmail(...args);
  } };
});
import { contactRoutes } from './contact.js';

function assertLegacyTestDatabase(raw: string): void {
  if (!isDisposablePostgresUrl(raw)) {
    throw new Error('legacy contact tests require a disposable database name ending in _test');
  }
}
assertLegacyTestDatabase(process.env.DATABASE_URL ?? env.DATABASE_URL);
const STORE = 'dddddddd-dddd-dddd-dddd-dddddddddddc';
const OTHER = 'dddddddd-dddd-dddd-dddd-dddddddddddb';
const SLUG = 'legacy-contact-fixture';
const OTHER_SLUG = 'legacy-contact-other';
const SECRET = 'legacy-contact-fixture-signing-key';
const OTHER_SECRET = 'different-store-fixture-signing-key';
const submission = { name: 'Ada', email: 'ada@example.com', subject: 'Legacy question', message: 'Already confirmed my address.' };
let issuedBefore: number;
const app = new OpenAPIHono();
app.route('/', contactRoutes);
// Expected fixture failures return 500 without relying on the outer app handler.
app.onError((_error, c) => c.text('fixture transaction failed', 500));

function link(ts = issuedBefore, secret = SECRET): { path: string; sig: string } {
  const data = Buffer.from(JSON.stringify(submission)).toString('base64url');
  const sig = createHmac('sha256', secret).update(`${data}:${ts}`).digest('hex');
  return { path: `/v1/shop/contact/confirm-legacy?${new URLSearchParams({ data, ts: String(ts), sig })}`, sig };
}
function click(path: string, slug = SLUG) {
  return app.request(`http://localhost${path}`, { headers: { 'x-store-slug': slug } });
}
async function state(storeId = STORE) {
  return withStore(storeId, async (tx) => {
    const contacts = await tx.execute(sql`SELECT status FROM contact_submission WHERE store_id = ${storeId}`);
    const emails = await tx.execute(sql`SELECT kind, recipient, dedupe_key FROM email_outbox WHERE store_id = ${storeId} ORDER BY kind`);
    const claims = await tx.execute(sql`SELECT id FROM processed_event WHERE store_id = ${storeId} AND type = 'legacy_contact_confirm'`);
    return { contacts: contacts.rows, emails: emails.rows, claims: claims.rows };
  });
}
async function wipe() { await pool.query('TRUNCATE store CASCADE'); }
beforeEach(async () => {
  await wipe();
  failure.ack = false;
  issuedBefore = Date.now();
  for (const [id, slug, contactEmail] of [[STORE, SLUG, 'team@example.com'], [OTHER, OTHER_SLUG, 'other-team@example.com']]) {
    await pool.query('INSERT INTO store (id, slug, name, currency, config) VALUES ($1, $2, $3, $4, $5)',
      [id, slug, slug, 'USD', JSON.stringify({ notifications: { contactEmail } })]);
  }
  invalidateStoreCache();
  vi.stubEnv('LEGACY_CONTACT_COMPAT_JSON', JSON.stringify({
    [STORE]: { secret: SECRET, issuedBefore }, [OTHER]: { secret: OTHER_SECRET, issuedBefore },
  }));
});
afterAll(async () => { vi.unstubAllEnvs(); await wipe(); await pool.end(); });

describe('legacy contact durable confirmation', () => {
  it('checks the actual database name before allowing destructive fixtures', () => {
    for (const raw of ['postgres://fixture_test:password@localhost/live', 'postgres://fixture:password_test@localhost/live',
      'postgres://fixture:password@localhost/live?application_name=fixture_test', 'postgres://fixture:password@localhost/live_test/other',
      'postgres://fixture:password@localhost/live_test%2Fother_test', 'not a URL', 'file:///fixture_test']) {
      expect(() => assertLegacyTestDatabase(raw)).toThrow('database name ending in _test');
    }
    expect(() => assertLegacyTestDatabase('postgresql://fixture:password@localhost/legacy_contact_test?application_name=ci')).not.toThrow();
  });

  it('materializes delivered contact + existing team/ack templates without a new confirmation', async () => {
    const { path, sig } = link();
    const response = await click(path);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    const actual = await state();
    expect(actual.contacts).toEqual([{ status: 'delivered' }]);
    expect(actual.claims).toEqual([{ id: legacyContactMarkerId(STORE, sig) }]);
    expect(actual.emails).toEqual([
      { kind: 'contact_ack', recipient: submission.email, dedupe_key: `${legacyContactMarkerId(STORE, sig)}:ack` },
      { kind: 'contact_team', recipient: 'team@example.com', dedupe_key: `${legacyContactMarkerId(STORE, sig)}:team` },
    ]);
    expect(await state(OTHER)).toEqual({ contacts: [], emails: [], claims: [] });
  });

  it('deduplicates racing & repeated clicks atomically', async () => {
    const { path } = link();
    const responses = await Promise.all(Array.from({ length: 6 }, () => click(path)));
    for (const response of responses) expect(response.status).toBe(200);
    expect((await click(path)).status).toBe(200);
    const actual = await state();
    expect(actual.contacts).toHaveLength(1);
    expect(actual.claims).toHaveLength(1);
    expect(actual.emails).toHaveLength(2);
  });

  it('accepts a transferred legacy Redis verified marker as already delivered, without resending', async () => {
    const { path, sig } = link();
    // Cutover marker-transfer fixture: import these IDs before opening traffic.
    await withStore(STORE, tx => tx.execute(sql`INSERT INTO processed_event (id, store_id, type)
      VALUES (${legacyContactMarkerId(STORE, sig)}, ${STORE}, 'legacy_contact_confirm') ON CONFLICT DO NOTHING`));
    expect((await click(path)).status).toBe(200);
    expect((await click(path)).status).toBe(200);
    expect(await state()).toEqual({ contacts: [], emails: [], claims: [{ id: legacyContactMarkerId(STORE, sig) }] });
  });

  it('does not let another tenant marker suppress its own valid legacy link', async () => {
    const { path, sig } = link();
    await withStore(OTHER, tx => tx.execute(sql`INSERT INTO processed_event (id, store_id, type)
      VALUES (${legacyContactMarkerId(OTHER, sig)}, ${OTHER}, 'legacy_contact_confirm')`));
    expect((await click(path)).status).toBe(200);
    expect((await state()).emails).toHaveLength(2);
    expect((await state(OTHER)).emails).toHaveLength(0);
  });

  it('rejects a shared-secret map for both tenants before claiming or delivering a signed link', async () => {
    const { path } = link();
    vi.stubEnv('LEGACY_CONTACT_COMPAT_JSON', JSON.stringify({
      [STORE]: { secret: SECRET, issuedBefore }, [OTHER]: { secret: SECRET, issuedBefore },
    }));
    expect((await click(path)).status).toBe(403);
    expect((await click(path, OTHER_SLUG)).status).toBe(403);
    expect(await state()).toEqual({ contacts: [], emails: [], claims: [] });
    expect(await state(OTHER)).toEqual({ contacts: [], emails: [], claims: [] });
  });

  it('rejects tenant crossing, missing/unknown binding, tampering, expired/future & post-freeze timestamps without writes', async () => {
    const { path } = link();
    expect((await click(path, OTHER_SLUG)).status).toBe(403);
    expect((await click(`${path}&s=${OTHER_SLUG}`)).status).toBe(400);
    expect((await click(path.replace(/sig=[^&]+/, `sig=${'0'.repeat(64)}`))).status).toBe(403);
    expect((await click(link(issuedBefore - 24 * 60 * 60 * 1000 - 1000).path)).status).toBe(410);
    expect((await click(link(issuedBefore + 1000).path)).status).toBe(410);
    vi.stubEnv('LEGACY_CONTACT_COMPAT_JSON', JSON.stringify({ [OTHER]: { secret: OTHER_SECRET, issuedBefore } }));
    expect((await click(path)).status).toBe(403);
    vi.stubEnv('LEGACY_CONTACT_COMPAT_JSON', '{');
    expect((await click(path)).status).toBe(403);
    expect(await state()).toEqual({ contacts: [], emails: [], claims: [] });
    expect(await state(OTHER)).toEqual({ contacts: [], emails: [], claims: [] });
  });

  it('rolls back claim, delivered row & first email if second enqueue fails, then safely retries', async () => {
    const { path } = link();
    failure.ack = true;
    expect((await click(path)).status).toBe(500);
    expect(await state()).toEqual({ contacts: [], emails: [], claims: [] });
    failure.ack = false;
    expect((await click(path)).status).toBe(200);
    const actual = await state();
    expect(actual.contacts).toHaveLength(1);
    expect(actual.claims).toHaveLength(1);
    expect(actual.emails).toHaveLength(2);
  });
});
