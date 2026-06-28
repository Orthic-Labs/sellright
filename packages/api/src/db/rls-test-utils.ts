import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';
import { expect } from 'vitest';

export const RLS_STORE_A = '11111111-1111-1111-1111-111111111111';
export const RLS_STORE_B = '22222222-2222-2222-2222-222222222222';

export function assertTestDatabase(databaseUrl: string, label: string): void {
 if (!/_test(\b|$|\?)/.test(databaseUrl)) {
  throw new Error(`${label} truncates data — point DATABASE_URL at a *_test database, got: ${databaseUrl.replace(/:[^:@/]+@/, ':***@')}`);
 }
}

export function createStoreAppRunner<TSchema extends Record<string, unknown> = Record<string, never>>(
 appPool: Pool,
 drizzleOpts: NonNullable<Parameters<typeof drizzle<TSchema, PoolClient>>[1]>,
) {
 type AppTx = ReturnType<typeof drizzle<TSchema, PoolClient>>;

 return async function withStoreApp<T>(storeId: string, fn: (tx: AppTx) => Promise<T>): Promise<T> {
  const client: PoolClient = await appPool.connect();
  try {
   await client.query('BEGIN');
   await client.query("SELECT set_config('app.current_store', $1, true)", [storeId]);
   const tx = drizzle(client, drizzleOpts);
   const result = await fn(tx);
   await client.query('COMMIT');
   return result;
  } catch (err) {
   await client.query('ROLLBACK');
   throw err;
  } finally {
   client.release();
  }
 };
}

export function rlsErrorText(e: unknown): string {
 const parts: string[] = [];
 let cur = e as { message?: unknown; cause?: unknown } | null | undefined;
 for (let i = 0; i < 5 && cur; i++) {
  parts.push(String(cur.message ?? cur));
  cur = cur.cause as { message?: unknown; cause?: unknown } | null | undefined;
 }
 return parts.join(' | ');
}

export async function expectRlsRejection(p: Promise<unknown>): Promise<void> {
 let err: unknown;
 try { await p; } catch (e) { err = e; }
 expect(err, 'expected RLS to reject the cross-tenant write').toBeDefined();
 expect(rlsErrorText(err), 'expected a row-level-security rejection').toMatch(/row-level security/i);
}
