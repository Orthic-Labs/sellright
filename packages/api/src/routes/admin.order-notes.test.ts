/**
 * DB tests — admin-essentials internal order notes.
 * POST /v1/admin/orders/{code}/notes writes into audit_log (entity='order',
 * action='note') so the note appears in the SAME timeline GET
 * /v1/admin/orders/{code} already returns for every other event — no new
 * table, no second feed to keep in sync.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { createAdminSession } from '../auth/admin-session.js';
import { admin as adminRoutes } from './admin.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`order-notes test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'bbbbbbbb-4444-4444-4444-444444444444';
const SLUG = 'order-notes-test-store';
const ADMIN = 'bbbbbbbb-4444-4444-4444-00000000000a';

const app = new OpenAPIHono();
app.route('/', adminRoutes);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
}

async function seed(): Promise<string> {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name) VALUES (${STORE}, ${SLUG}, ${SLUG}) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO admin_user (id, email, password_hash) VALUES (${ADMIN}, 'owner@order-notes.test', 'x') ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES (${ADMIN}, ${STORE}, 'owner') ON CONFLICT DO NOTHING`);
    await tx.execute(sql`INSERT INTO "order" (id, store_id, code, state, currency, grand_total) VALUES (gen_random_uuid(), ${STORE}, 'ON-1', 'Paid'::order_state, 'USD', 1000) ON CONFLICT DO NOTHING`);
  });
  return createAdminSession(ADMIN);
}

async function addNote(code: string, note: string) {
  const res = await app.request(`/v1/admin/orders/${code}/notes`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG, 'content-type': 'application/json' },
    body: JSON.stringify({ note }),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
async function getOrder(code: string) {
  const res = await app.request(`/v1/admin/orders/${code}`, { headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG } });
  return { status: res.status, body: await res.json() as { events: Array<{ action: string; actor: string | null; data?: { note?: string } }> } };
}

let token = '';
beforeEach(async () => { await wipe(); token = await seed(); });
afterAll(async () => { await wipe(); await pool.end(); });

describe('POST /v1/admin/orders/{code}/notes', () => {
  it('adds a note that appears in the order timeline with the acting admin as actor', async () => {
    const res = await addNote('ON-1', 'Customer called about a delayed shipment.');
    expect(res.status).toBe(200);
    expect(typeof res.body.id).toBe('string');

    const order = await getOrder('ON-1');
    const noteEvent = order.body.events.find((e) => e.action === 'note');
    expect(noteEvent).toMatchObject({ actor: 'owner@order-notes.test', data: { note: 'Customer called about a delayed shipment.' } });
  });

  it('rejects a blank note', async () => {
    const res = await addNote('ON-1', '   ');
    expect(res.status).toBe(400);
  });

  it('404s for an unknown order code', async () => {
    const res = await addNote('NOPE', 'hello');
    expect(res.status).toBe(404);
  });

  it('multiple notes all appear, most recent first, alongside other order events', async () => {
    await addNote('ON-1', 'first note');
    await addNote('ON-1', 'second note');
    const order = await getOrder('ON-1');
    const notes = order.body.events.filter((e) => e.action === 'note').map((e) => e.data?.note);
    expect(notes).toEqual(['second note', 'first note']);
  });

  it('non-note events do not carry a data.note field', async () => {
    await withStore(STORE, async (tx) => {
      await tx.execute(sql`INSERT INTO audit_log (store_id, actor, entity, entity_id, action, to_state) VALUES (${STORE}, 'system', 'order', (SELECT id FROM "order" WHERE code = 'ON-1'), 'fulfill', 'Shipped')`);
    });
    const order = await getOrder('ON-1');
    const fulfillEvent = order.body.events.find((e) => e.action === 'fulfill');
    expect(fulfillEvent?.data).toBeUndefined();
  });
});
