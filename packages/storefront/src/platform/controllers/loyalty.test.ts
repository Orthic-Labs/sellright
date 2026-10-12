// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ACTION_RESULTS, dispatch, type ActionCtl } from './callbacks';
import { buildLoyaltyView, decideToggle, offerFor, reconcileRedemption, type LoyaltyAccount } from './loyalty';

const program = { enabled: true, earnRatePerDollar: 100, pointsPerDollarOff: 100, minRedeemPoints: 500, maxRedeemPercentOfSubtotal: 50 } as never;
const account = (available: number): LoyaltyAccount => ({ available, program });

describe('loyalty offer and projection', () => {
	it('offer = redeem what the discountable amount allows (cap 50% of $20.00 = $10.00 = 1000 points)', () => {
		expect(offerFor(account(5000), 2000)).toEqual({ points: 1000, discountCents: 1000 });
		expect(offerFor(account(1200), 2000)).toEqual({ points: 1000, discountCents: 1000 });
		expect(offerFor(account(600), 2000)).toEqual({ points: 600, discountCents: 600 });
	});

	it('offer is null below the minimum, with no points, or with nothing discountable', () => {
		expect(offerFor(account(400), 2000)).toBeNull();
		expect(offerFor(account(0), 2000)).toBeNull();
		expect(offerFor(account(5000), 0)).toBeNull();
	});

	it('the view carries balance, minimum (for the base message), offer, applied and the amount; null account = no view', () => {
		expect(buildLoyaltyView(null, 0, 2000, 'USD')).toBeNull();
		expect(buildLoyaltyView(account(5000), 0, 2000, 'USD')).toEqual({
			balance: 5000, minRedeemPoints: 500, offer: { points: 1000, discountCents: 1000 }, applied: null, discountableCents: 2000, currencyCode: 'USD',
		});
		expect(buildLoyaltyView(account(5000), 600, 2000, 'USD')?.applied).toEqual({ points: 600, discountCents: 600 });
	});

	it('the minimum-points state is distinguishable (balance below minRedeemPoints, no offer)', () => {
		const v = buildLoyaltyView(account(300), 0, 2000, 'USD')!;
		expect(v.offer).toBeNull();
		expect(v.balance).toBeGreaterThan(0);
		expect(v.balance).toBeLessThan(v.minRedeemPoints);
	});
});

describe('toggle', () => {
	it('toggle with offer null -> invalid, no state change', () => {
		expect(decideToggle(account(300), true, 2000)).toEqual({ result: { ok: false, reason: 'invalid' }, points: null });
		expect(decideToggle(null, true, 2000)).toEqual({ result: { ok: false, reason: 'invalid' }, points: null });
	});

	it('toggle on sets the redemption to offer.points; off sets 0', () => {
		expect(decideToggle(account(5000), true, 2000)).toEqual({ result: { ok: true }, points: 1000 });
		expect(decideToggle(account(5000), false, 2000)).toEqual({ result: { ok: true }, points: 0 });
		expect(decideToggle(null, false, 2000)).toEqual({ result: { ok: true }, points: 0 });
	});

	it('through the dispatcher: the controller signal is set to offer.points, the promise resolves after it is applied, forged args change nothing', async () => {
		const ctl: ActionCtl = { disposed: false, admitted: [] };
		const state = { redeemPoints: 0, discountable: 2000 };
		const acct = account(5000);
		const toggle = (on: boolean) => dispatch(ctl, null, ACTION_RESULTS, () => {
			const { result, points } = decideToggle(acct, on, state.discountable);
			if (points !== null) state.redeemPoints = points;
			return result;
		});
		expect(await toggle(true)).toEqual({ ok: true });
		expect(state.redeemPoints).toBe(1000);
		expect(await toggle(false)).toEqual({ ok: true });
		expect(state.redeemPoints).toBe(0);
		state.discountable = 0;
		expect(await toggle(true)).toEqual({ ok: false, reason: 'invalid' });
		expect(state.redeemPoints).toBe(0);
	});
});

describe('reconcileRedemption (discountableCents changes)', () => {
	it('keeps a redemption that is still within the offer', () => {
		expect(reconcileRedemption(account(5000), 800, 2000)).toBe(800);
	});

	it('an applied redemption above the new offer is reset to the new offer points', () => {
		expect(reconcileRedemption(account(5000), 1000, 1200)).toBe(600);
	});

	it('...or to 0 when nothing is redeemable any more', () => {
		expect(reconcileRedemption(account(5000), 1000, 0)).toBe(0);
		expect(reconcileRedemption(account(5000), 1000, 400)).toBe(0); // 50% of $4 = $2 = 200 points < minimum
	});

	it('0 stays 0; with no account loaded the held value is left to the server to validate', () => {
		expect(reconcileRedemption(account(5000), 0, 2000)).toBe(0);
		expect(reconcileRedemption(null, 700, 2000)).toBe(700);
	});
});
