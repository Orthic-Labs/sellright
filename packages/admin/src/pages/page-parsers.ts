import { parseMoney } from '../redesign/order-model';

/** Strict parsers for admin page inputs (audit 2026-11-09: AD-H3, AD-M3, AD-H5). */

/** Tax/zone rate percent text to basis points. Only digits with up to 2 decimals; "8,5", "-1", "" and "1e2" are null. */
export function parsePercentBps(raw: string): number | null {
  const v = raw.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(v)) return null;
  return Math.round(Number(v) * 100);
}

/** On-hand text to a whole number of 0 or more; empty or anything else is null. */
export function parseOnHand(raw: string): number | null {
  const v = raw.trim();
  if (!/^\d{1,9}$/.test(v)) return null;
  return Number(v);
}

/** Signed money text ("+5.00", "-5", "5") to cents; null when empty, zero or not a plain amount. */
export function parseSignedMoney(raw: string): number | null {
  const v = raw.trim();
  const sign = v.startsWith('-') ? -1 : 1;
  const body = /^[+-]/.test(v) ? v.slice(1).trim() : v;
  if (body === '') return null;
  const cents = parseMoney(body);
  if (cents === null || cents === 0) return null;
  return sign * cents;
}
