/** The four-payment schedule the installment tab shows (ported from the previous store's installment panel). */
export const INSTALLMENT_COUNT = 4;
export const INSTALLMENT_WHEN: readonly string[] = ['Today', 'Week 2', 'Week 4', 'Week 6'];

/**
 * Splits a total (cents) into four payments: every payment is the floor of a quarter, and the remainder cents go to
 * the earliest payments, so the four always add back up to the total ("Today" is never the smaller share).
 */
export function installmentSchedule(totalCents: number): number[] {
	const total = Number.isFinite(totalCents) && totalCents > 0 ? Math.floor(totalCents) : 0;
	const base = Math.floor(total / INSTALLMENT_COUNT);
	const remainder = total % INSTALLMENT_COUNT;
	return INSTALLMENT_WHEN.map((_, i) => base + (remainder > i ? 1 : 0));
}
