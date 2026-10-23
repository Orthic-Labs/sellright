/**
 * Sequential, store-configurable order numbers (issue #309).
 *
 * One row per store in `order_number_sequence` (migration 0109) holds the format (prefix, suffix, minimum digits)
 * and the next number. Every order-creating path (shop checkout incl. express checkout, admin-created orders,
 * subscription sign-ups) takes its code here, inside the transaction that inserts the order:
 *
 *   INSERT … ON CONFLICT (store_id) DO UPDATE SET next_number = next_number + 1 RETURNING …
 *
 * The row lock is held until that transaction ends, so concurrent orders of one store get distinct, consecutive
 * numbers; a rolled-back order leaves a gap and never a duplicate. A store without a row gets the default format
 * (no prefix, starting at 1001) on its first order. Existing codes are never rewritten: a candidate that already
 * exists (an imported order, say) moves the counter past the highest matching code, and the unique (store_id, code)
 * constraint stays the final guard — `withOrderNumber` retries on it inside a savepoint.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { withSavepoint } from '../db/savepoint.js';

export interface OrderNumberFormat { prefix: string; suffix: string; minDigits: number }
export interface OrderNumbering extends OrderNumberFormat { nextNumber: number }

export const DEFAULT_ORDER_NUMBERING: Readonly<OrderNumbering> = Object.freeze({ prefix: '', suffix: '', minDigits: 0, nextNumber: 1001 });
/** Largest number the counter may hand out (12 digits; well inside Number.MAX_SAFE_INTEGER and the bigint column). */
export const MAX_ORDER_NUMBER = 999_999_999_999;
export const MAX_MIN_DIGITS = 12;
export const MAX_AFFIX_LENGTH = 16;
const AFFIX_CHARS = /^[A-Za-z0-9#_./-]*$/;

/** prefix + zero-padded number + suffix. */
export function formatOrderCode(format: OrderNumberFormat, n: number): string {
  return format.prefix + String(n).padStart(format.minDigits, '0') + format.suffix;
}

const escapeLiteral = (s: string) => s.replace(/[^A-Za-z0-9]/g, (ch) => '\\' + ch);

/** Anchored pattern capturing the number of a code in this format. Valid as a JS RegExp and as a Postgres ARE
 *  (`~`): affixes are restricted to [A-Za-z0-9#_./-] and every non-alphanumeric is backslash-escaped. Matches any
 *  digit count, so a padded or unpadded variant of the same number is treated as taken (conservative). */
export function orderCodePattern(format: Pick<OrderNumberFormat, 'prefix' | 'suffix'>): string {
  return `^${escapeLiteral(format.prefix)}([0-9]+)${escapeLiteral(format.suffix)}$`;
}

/** The number inside `code` when it matches the format, else null. */
export function parseOrderNumber(format: Pick<OrderNumberFormat, 'prefix' | 'suffix'>, code: string): number | null {
  const m = new RegExp(orderCodePattern(format)).exec(code);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : null;
}

/** Shape rules for a configuration; returns a message, or null when valid. A prefix may not end and a suffix may
 *  not start with a digit, so the number inside a code is unambiguous. */
export function orderNumberingError(v: OrderNumbering): string | null {
  for (const [name, value] of [['prefix', v.prefix], ['suffix', v.suffix]] as const) {
    if (value.length > MAX_AFFIX_LENGTH) return `${name} must be at most ${MAX_AFFIX_LENGTH} characters`;
    if (!AFFIX_CHARS.test(value)) return `${name} may contain only letters, digits and # _ . / -`;
  }
  if (/[0-9]$/.test(v.prefix)) return 'prefix must not end with a digit';
  if (/^[0-9]/.test(v.suffix)) return 'suffix must not start with a digit';
  if (!Number.isInteger(v.minDigits) || v.minDigits < 0 || v.minDigits > MAX_MIN_DIGITS) return `minimum digits must be between 0 and ${MAX_MIN_DIGITS}`;
  if (!Number.isSafeInteger(v.nextNumber) || v.nextNumber < 1 || v.nextNumber > MAX_ORDER_NUMBER) return `next number must be between 1 and ${MAX_ORDER_NUMBER}`;
  return null;
}

/** Codes a customer-typed order reference may stand for, exact match first: as typed, upper-cased, and with or
 *  without a leading '#' (people copy "#1001" from an e-mail, or type "1001" for a code configured with a '#'
 *  prefix). For lookups that also prove ownership (guest tracking checks the e-mail); never widens what a match
 *  authorizes. */
export function orderCodeCandidates(input: string): string[] {
  const typed = input.trim();
  const out: string[] = [];
  for (const base of [typed, typed.toUpperCase()]) {
    const bare = base.replace(/^#+/, '');
    for (const v of [base, bare, '#' + bare]) if (v && v !== '#' && !out.includes(v)) out.push(v);
  }
  return out;
}

type Row = Record<string, unknown>;
const rowsOf = (r: unknown): Row[] => ((r as { rows?: Row[] }).rows ?? (r as Row[]));
const toNumbering = (r: Row): OrderNumbering => ({
  prefix: String(r.prefix ?? ''), suffix: String(r.suffix ?? ''), minDigits: Number(r.min_digits ?? 0), nextNumber: Number(r.next_number),
});

/** The store's configuration, or the default when it has none yet. */
export async function readOrderNumbering(tx: Tx, storeId: string, opts: { forUpdate?: boolean } = {}): Promise<OrderNumbering> {
  const r = rowsOf(await tx.execute(opts.forUpdate
    ? sql`SELECT prefix, suffix, min_digits, next_number FROM order_number_sequence WHERE store_id = ${storeId} FOR UPDATE`
    : sql`SELECT prefix, suffix, min_digits, next_number FROM order_number_sequence WHERE store_id = ${storeId}`));
  return r[0] ? toNumbering(r[0]) : { ...DEFAULT_ORDER_NUMBERING };
}

/** The highest existing order code of this store that matches the format (by number), or null. Reads every order
 *  row (trashed included): a trashed order still owns its code. */
export async function highestMatchingCode(tx: Tx, storeId: string, format: Pick<OrderNumberFormat, 'prefix' | 'suffix'>): Promise<{ code: string; number: number } | null> {
  const pattern = orderCodePattern(format);
  const r = rowsOf(await tx.execute(sql`SELECT code, substring(code from ${pattern})::numeric AS n FROM "order"
    WHERE store_id = ${storeId} AND code ~ ${pattern} ORDER BY n DESC, code LIMIT 1`));
  if (!r[0]) return null;
  return { code: String(r[0].code), number: Number(r[0].n) };
}

/** Move the counter past the highest existing code that matches the store's format (never backwards). Creates the
 *  row with the default format when missing. Used after an order import and when a candidate code is taken.
 *  Returns the resulting configuration. */
export async function bumpOrderNumberPastExisting(tx: Tx, storeId: string): Promise<OrderNumbering> {
  await tx.execute(sql`INSERT INTO order_number_sequence (store_id, next_number) VALUES (${storeId}, ${DEFAULT_ORDER_NUMBERING.nextNumber})
    ON CONFLICT (store_id) DO NOTHING`);
  const current = await readOrderNumbering(tx, storeId, { forUpdate: true });
  const highest = await highestMatchingCode(tx, storeId, current);
  if (highest && highest.number >= current.nextNumber) {
    if (highest.number >= MAX_ORDER_NUMBER) throw new Error(`order number space exhausted for format ${formatOrderCode(current, 0)} (highest ${highest.code})`);
    await tx.execute(sql`UPDATE order_number_sequence SET next_number = ${highest.number + 1}, updated_at = now() WHERE store_id = ${storeId}`);
    return { ...current, nextNumber: highest.number + 1 };
  }
  return current;
}

/** Take the next number and return its code. Must run inside the transaction that inserts the order: the counter
 *  row stays locked until that transaction ends. A code that already exists moves the counter past the highest
 *  matching code and takes the next one. */
export async function nextOrderCode(tx: Tx, storeId: string): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = rowsOf(await tx.execute(sql`INSERT INTO order_number_sequence AS q (store_id, next_number)
      VALUES (${storeId}, ${DEFAULT_ORDER_NUMBERING.nextNumber + 1})
      ON CONFLICT (store_id) DO UPDATE SET next_number = q.next_number + 1, updated_at = now()
      RETURNING q.prefix, q.suffix, q.min_digits, q.next_number - 1 AS next_number`));
    const taken = toNumbering(r[0]!);
    if (taken.nextNumber > MAX_ORDER_NUMBER) throw new Error('order number space exhausted; change the order number format');
    const code = formatOrderCode(taken, taken.nextNumber);
    const exists = rowsOf(await tx.execute(sql`SELECT 1 FROM "order" WHERE store_id = ${storeId} AND code = ${code} LIMIT 1`));
    if (!exists.length) return code;
    await bumpOrderNumberPastExisting(tx, storeId);
  }
  throw new Error('could not allocate a free order code');
}

/** True when `e` is the unique (store_id, code) violation on "order". */
export function isOrderCodeConflict(e: unknown): boolean {
  for (let cur: unknown = e, depth = 0; cur && typeof cur === 'object' && depth < 5; depth++) {
    const err = cur as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (err.code === '23505' && err.constraint === 'order_store_code') return true;
    cur = err.cause;
  }
  return false;
}

/** Allocate a code and run `insert(code)` (the order insert and anything that must commit with it) inside a
 *  savepoint. When the unique (store_id, code) constraint rejects it — a code committed concurrently by another
 *  writer, such as an import — the counter moves past it and the insert is retried with the next code. */
export async function withOrderNumber<T>(tx: Tx, storeId: string, insert: (code: string) => Promise<T>): Promise<{ code: string; result: T }> {
  for (let attempt = 0; ; attempt++) {
    const code = await nextOrderCode(tx, storeId);
    try {
      return { code, result: await withSavepoint(tx, () => insert(code)) };
    } catch (e) {
      if (attempt >= 2 || !isOrderCodeConflict(e)) throw e;
    }
  }
}
