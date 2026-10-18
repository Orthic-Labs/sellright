import { AccountCreditError, type AccountCreditAllocation } from './types.js';

export const MAX_CREDIT_CENTS = 2_147_483_647;
export function assertCents(value: number, label = 'Amount', positive = false): void {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0) || value > MAX_CREDIT_CENTS) {
    throw new AccountCreditError('invalid_input', `${label} must fit ${positive ? 'positive' : 'nonnegative'} integer cents`);
  }
}
export function normalizeCreditEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new AccountCreditError('invalid_input', 'Valid issuance email required');
  }
  return normalized;
}
export function availableCredit(balance: number, holds: readonly { amount: number; orderId: string | null }[], exceptOrderId?: string): number {
  assertCents(balance, 'Balance');
  let held = 0;
  for (const hold of holds) {
    assertCents(hold.amount, 'Hold');
    if (exceptOrderId !== undefined && hold.orderId === exceptOrderId) continue;
    held += hold.amount;
    if (!Number.isSafeInteger(held)) throw new AccountCreditError('invariant', 'Held credit overflow');
  }
  if (held > balance) throw new AccountCreditError('invariant', 'Pending holds exceed balance');
  return balance - held;
}
/** Validate exact, persisted per-unit cents; no proportional recomputation at refund time. */
export function validateAllocation(allocation: AccountCreditAllocation, lines: readonly { id: string; quantity: number }[], applied: number): void {
  assertCents(applied, 'Applied amount');
  if (!allocation || typeof allocation !== 'object' || Array.isArray(allocation) || Object.keys(allocation).length !== lines.length) {
    throw new AccountCreditError('allocation', 'Credit allocation must cover exactly the purchased lines');
  }
  let total = 0;
  for (const line of lines) {
    const units = Object.hasOwn(allocation, line.id) ? allocation[line.id] : undefined;
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1 || !Array.isArray(units) || units.length !== line.quantity) {
      throw new AccountCreditError('allocation', 'Credit unit allocation missing at settlement');
    }
    for (const cents of units) {
      assertCents(cents, 'Unit allocation');
      total += cents;
      if (!Number.isSafeInteger(total) || total > MAX_CREDIT_CENTS) throw new AccountCreditError('allocation', 'Credit allocation overflow');
    }
  }
  if (total !== applied) throw new AccountCreditError('allocation', 'Credit allocation does not match redemption');
}
export function equalAllocation(a: AccountCreditAllocation | null, b: AccountCreditAllocation): boolean {
  if (!a || !b || Object.keys(a).length !== Object.keys(b).length) return false;
  return Object.keys(a).every(key => Object.hasOwn(b, key) && Array.isArray(a[key]) && Array.isArray(b[key]) &&
    a[key]!.length === b[key]!.length && a[key]!.every((value, i) => value === b[key]![i]));
}
export function restorationAmount(units: readonly number[], restoredQuantity: number, quantity: number, expectedCents?: number): number {
  if (!Array.isArray(units) || !Number.isSafeInteger(restoredQuantity) || restoredQuantity < 0 ||
      !Number.isSafeInteger(quantity) || quantity < 1 || restoredQuantity + quantity > units.length) {
    throw new AccountCreditError('allocation', 'Return quantity exceeds purchased quantity');
  }
  for (const cents of units) assertCents(cents, 'Stored unit allocation');
  const amount = units.slice(restoredQuantity, restoredQuantity + quantity).reduce((sum, cents) => sum + cents, 0);
  assertCents(amount, 'Restoration');
  if (expectedCents !== undefined && amount !== expectedCents) throw new AccountCreditError('conflict', 'Restoration differs from approved allocation');
  return amount;
}
