import type { Tx } from '../db/client.js';
import * as s from '../db/schema.js';

/** Fixed, deterministic id for the DD store so every importer slice shares it
 *  (avoids looking up an RLS-protected store row). */
export const DD_STORE_ID = '0a000000-0000-4000-8000-0000000000dd';

export async function ensureDdStore(tx: Tx): Promise<void> {
  await tx
    .insert(s.store)
    .values({ id: DD_STORE_ID, slug: 'damned', name: 'Damned Designs', currency: 'USD' })
    .onConflictDoNothing();
}

export function parseJson(v: string | null): unknown | null {
  if (v == null || v === '') return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

export function parseStrArray(v: string | null): string[] | null {
  const j = parseJson(v);
  return Array.isArray(j) ? j.filter((x): x is string => typeof x === 'string') : null;
}

export function parseDate(v: string | null): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
