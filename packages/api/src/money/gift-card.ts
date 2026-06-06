/**
 * Gift card / store credit redemption math. Pure — the caller loads the card and
 * persists the draw-down. A gift card is a TENDER, not a discount: it pays down
 * the order's amount due, never changes subtotal/tax/total.
 */
export type GiftCardState = { balance: number; enabled: boolean; expiresAt: Date | null };

export type GiftCardApplication = {
  applicable: boolean;
  reason?: 'disabled' | 'expired' | 'empty';
  applied: number; // cents drawn from the card
  remainingDue: number; // order cents still owed after the card
  newBalance: number; // card cents left after the draw-down
};

/** Apply `card` against an `amountDue` (cents). `now` injected for testability. */
export function applyGiftCard(card: GiftCardState, amountDue: number, now: Date): GiftCardApplication {
  const none = { applied: 0, remainingDue: Math.max(0, amountDue), newBalance: card.balance };
  if (!card.enabled) return { applicable: false, reason: 'disabled', ...none };
  if (card.expiresAt && card.expiresAt.getTime() <= now.getTime()) return { applicable: false, reason: 'expired', ...none };
  if (card.balance <= 0) return { applicable: false, reason: 'empty', ...none };
  const applied = Math.max(0, Math.min(card.balance, amountDue));
  return { applicable: applied > 0, applied, remainingDue: amountDue - applied, newBalance: card.balance - applied };
}
