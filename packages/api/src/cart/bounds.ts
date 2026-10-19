import { asc, eq } from 'drizzle-orm';
import { type Tx } from '../db/client.js';
import * as s from '../db/schema.js';

// Checkout and legacy migration already accept at most 200 raw lines.
export const MAX_CART_LINES = 200;
export type CartItem = { sku: string; quantity: number };
export type CartBoundState = { status: string; revision: number };
export type CartBoundReason = 'converted' | 'merged' | 'stale' | 'revision_required';
export class CartTooLargeError extends Error {
  constructor(readonly state: CartBoundState, readonly reason?: CartBoundReason) {
    super('Cart exceeds ' + MAX_CART_LINES + ' distinct SKUs');
  }
}
export function cartTooLargeFields(error: CartTooLargeError) {
  return { status: error.state.status, revision: error.state.revision, ...(error.reason ? { code: error.reason } : {}) };
}

/** Set duplicates are last-write-wins, including removal; appends sum. */
export function normalizeCartLines(lines: CartItem[], mode: 'set' | 'increment'): CartItem[] {
  const quantities = new Map<string, number>();
  for (const line of lines) {
    if (mode === 'increment' && line.quantity <= 0) continue;
    quantities.set(line.sku, mode === 'increment' ? (quantities.get(line.sku) ?? 0) + line.quantity : line.quantity);
  }
  return [...quantities].map(([sku, quantity]) => ({ sku, quantity }));
}

/** Fetch one sentinel row beyond budget; never price a partial snapshot. */
export async function boundedCartItems(tx: Tx, row: { id: string } & CartBoundState, reason?: CartBoundReason): Promise<CartItem[]> {
  const items = await tx.select({ sku: s.cartLine.sku, quantity: s.cartLine.quantity }).from(s.cartLine)
    .where(eq(s.cartLine.cartId, row.id)).orderBy(asc(s.cartLine.createdAt), asc(s.cartLine.id)).limit(MAX_CART_LINES + 1);
  if (items.length > MAX_CART_LINES) throw new CartTooLargeError(row, reason);
  return items;
}
