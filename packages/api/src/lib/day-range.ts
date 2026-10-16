/**
 * Inclusive UTC day ranges for admin reports (affiliate stats, waitlist
 * demand). Same convention as the order export (orders/export.ts): `from` /
 * `to` are YYYY-MM-DD, both inclusive, evaluated in UTC; either may be open.
 */
import { sql, type SQL } from 'drizzle-orm';

export interface DayRange { from?: string; to?: string }

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True only for a real calendar day (rejects 2026-02-31, which Date would roll over). */
export function isValidDay(v: string): boolean {
  if (!DAY_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** Returns an error message, or null when the (possibly open-ended) range is valid. */
export function dayRangeError(r: DayRange): string | null {
  if (r.from !== undefined && !isValidDay(r.from)) return 'from must be a real date (YYYY-MM-DD)';
  if (r.to !== undefined && !isValidDay(r.to)) return 'to must be a real date (YYYY-MM-DD)';
  if (r.from && r.to && r.from > r.to) return 'from must not be after to';
  return null;
}

/** WHERE fragments bounding `column` (a timestamptz expression) to the range; [] when open. */
export function dayRangeConditions(column: SQL, r: DayRange): SQL[] {
  const out: SQL[] = [];
  if (r.from) out.push(sql`${column} >= ${`${r.from}T00:00:00Z`}::timestamptz`);
  if (r.to) out.push(sql`${column} < (${`${r.to}T00:00:00Z`}::timestamptz + interval '1 day')`);
  return out;
}
