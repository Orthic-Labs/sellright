/**
 * Gift card / store credit redemption math. Pure — the caller loads the card and
 * persists the draw-down. A gift card is a TENDER, not a discount: it pays down
 * the order's amount due, never changes subtotal/tax/total.
 *
 * Launch invariant: one settled tender per checkout. The current refund flow is
 * payment-scoped, so allowing a partial gift-card draw followed by a gateway
 * payment would create a split tender that cannot yet be refunded atomically.
 * Until tender-aware refund allocation exists, a gift card must cover the full
 * amount due or it is left untouched.
 */
export type GiftCardState = { balance: number; enabled: boolean; expiresAt: Date | null };

export type GiftCardApplication = {
  applicable: boolean;
  reason?: 'disabled' | 'expired' | 'empty' | 'insufficient_balance';
  applied: number; // cents drawn from the card
  remainingDue: number; // order cents still owed after the card
  newBalance: number; // card cents left after the draw-down
};

/** Apply `card` against an `amountDue` (cents). `now` injected for testability. */
export function applyGiftCard(card: GiftCardState, amountDue: number, now: Date): GiftCardApplication {
  const due = Math.max(0, amountDue);
  const none = { applied: 0, remainingDue: due, newBalance: card.balance };
  if (!card.enabled) return { applicable: false, reason: 'disabled', ...none };
  if (card.expiresAt && card.expiresAt.getTime() <= now.getTime()) return { applicable: false, reason: 'expired', ...none };
  if (card.balance <= 0) return { applicable: false, reason: 'empty', ...none };
  if (card.balance < due) return { applicable: false, reason: 'insufficient_balance', ...none };
  const applied = due;
  return { applicable: applied > 0, applied, remainingDue: 0, newBalance: card.balance - applied };
}
