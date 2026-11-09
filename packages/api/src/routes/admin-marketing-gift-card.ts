/** Gift-card balance adjustment arithmetic (pure): the balance never goes below 0 and the ledger records what was really applied. */
export function applyGiftCardAdjust(balance: number, adjust: number): { balance: number; appliedDelta: number } {
  const next = Math.max(0, balance + adjust);
  return { balance: next, appliedDelta: next - balance };
}
