import { requireDisposablePostgresUrl as assertTestDatabase } from '../db/test-database-url.js';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';

// Keep the real transaction/after-commit boundary. Inject a late callback
// failure after the route has scheduled cleanup, but before COMMIT.
const transaction = vi.hoisted(() => ({ failAfterHandler: false, beforeCommit: vi.fn() }));
vi.mock('../db/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/client.js')>();
  return {
    ...actual,
    withStore: <T>(storeId: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
      actual.withStore(storeId, async (tx) => {
        const result = await fn(tx);
        transaction.beforeCommit();
        if (transaction.failAfterHandler) throw new Error('injected failure before commit');
        return result;
      }),
  };
});

import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { createAdminSession } from '../auth/admin-session.js';
import { adminAssets } from './admin-assets.js';

assertTestDatabase(process.env.DATABASE_URL ?? env.DATABASE_URL, 'admin-assets.delete.db.test.ts');

const STORE = 'aa55aa55-1111-4444-8888-111111111111';
const ADMIN = 'aa55aa55-1111-4444-8888-222222222222';
const ASSET = 'aa55aa55-1111-4444-8888-333333333333';
const SLUG = 'asset-delete-test';
const ASSET_PATH = `${SLUG}/2026/10/fixture.webp`;
const remove = vi.spyOn(fs, 'rm').mockResolvedValue(undefined);
const app = new OpenAPIHono();
app.route('/', adminAssets);
app.onError((_error, c) => c.json({ error: 'transaction failed' }, 500));
let token = '';

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
}

async function assetCount(): Promise<number> {
  const result = await pool.query('SELECT count(*)::int AS n FROM asset WHERE id = $1', [ASSET]);
  return (result.rows[0] as { n: number }).n;
}

function deleteAsset(id = ASSET) {
  return app.request(`/v1/admin/assets/${id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG },
  });
}

beforeEach(async () => {
  transaction.failAfterHandler = false;
  transaction.beforeCommit.mockReset();
  remove.mockReset().mockResolvedValue(undefined);
  await wipe();
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name) VALUES (${STORE}, ${SLUG}, ${SLUG})`);
    await tx.execute(sql`INSERT INTO admin_user (id, email, password_hash) VALUES (${ADMIN}, 'owner@asset-delete.test', 'x')`);
    await tx.execute(sql`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES (${ADMIN}, ${STORE}, 'owner')`);
    await tx.execute(sql`INSERT INTO asset (id, store_id, type, path) VALUES (${ASSET}, ${STORE}, 'image', ${ASSET_PATH})`);
  });
  token = await createAdminSession(ADMIN);
  transaction.beforeCommit.mockClear();
});

afterAll(async () => {
  transaction.failAfterHandler = false;
  transaction.beforeCommit.mockReset();
  remove.mockRestore();
  await wipe();
  await pool.end();
});

describe('DELETE /v1/admin/assets/{id}', () => {
  it('removes an unreferenced file only after the row deletion commits', async () => {
    transaction.beforeCommit.mockImplementation(() => expect(remove).not.toHaveBeenCalled());

    const response = await deleteAsset();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(transaction.beforeCommit).toHaveBeenCalledOnce();
    expect(await assetCount()).toBe(0);
    expect(remove).toHaveBeenCalledExactlyOnceWith(path.join(env.ASSET_DIR, ASSET_PATH), { force: true });
  });

  it('leaves file cleanup untouched when a late transaction failure rolls back deletion', async () => {
    transaction.failAfterHandler = true;

    const response = await deleteAsset();

    expect(response.status).toBe(500);
    expect(await assetCount()).toBe(1);
    expect(remove).not.toHaveBeenCalled();
  });

  it('returns 409 for a blog featured image without deleting its row or file', async () => {
    await withStore(STORE, async (tx) => {
      await tx.execute(sql`INSERT INTO blog_post (store_id, title, slug, featured_asset_id)
        VALUES (${STORE}, 'Featured image', 'featured-image', ${ASSET})`);
    });

    const response = await deleteAsset();

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { message: expect.stringContaining('asset is referenced') } });
    expect(await assetCount()).toBe(1);
    expect(remove).not.toHaveBeenCalled();
  });

  it('keeps successful deletion best-effort when committed file cleanup fails', async () => {
    remove.mockRejectedValueOnce(new Error('disk unavailable'));

    const response = await deleteAsset();

    expect(response.status).toBe(200);
    expect(await assetCount()).toBe(0);
    expect(remove).toHaveBeenCalledOnce();
  });

  it('returns 404 for a missing asset without touching files', async () => {
    const response = await deleteAsset('aa55aa55-1111-4444-8888-444444444444');

    expect(response.status).toBe(404);
    expect(remove).not.toHaveBeenCalled();
  });

  it('preserves the read-only staff gate', async () => {
    await pool.query("UPDATE admin_user_store SET role = 'read_only' WHERE admin_user_id = $1", [ADMIN]);

    const response = await deleteAsset();

    expect(response.status).toBe(403);
    expect(await assetCount()).toBe(1);
    expect(remove).not.toHaveBeenCalled();
  });
});
