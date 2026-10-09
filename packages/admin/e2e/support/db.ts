/**
 * Read-only verification queries against the throwaway e2e database, for facts no admin endpoint exposes
 * (e.g. customer.tags is write-only in the admin API). Runs inside a transaction with the tenant GUC set,
 * so it behaves under FORCE RLS exactly like the API itself. Never used to arrange state.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { API_DIR, DB_OWNER_URL } from './env.mjs';
import type { AdminApi } from './api';

const { Client } = createRequire(join(API_DIR, 'package.json'))('pg');

export async function readRows<T = Record<string, unknown>>(api: AdminApi, sqlText: string, params: unknown[] = []): Promise<T[]> {
	const me = await api.get<{ stores: { storeId: string; slug: string }[] }>('/me');
	const storeId = me.stores.find((s) => s.slug === api.slug)!.storeId;
	const c = new Client({ connectionString: DB_OWNER_URL });
	await c.connect();
	try {
		await c.query('BEGIN READ ONLY');
		await c.query("SELECT set_config('app.current_store', $1, true)", [storeId]);
		const r = await c.query(sqlText, params);
		await c.query('ROLLBACK');
		return r.rows as T[];
	} finally {
		await c.end();
	}
}
