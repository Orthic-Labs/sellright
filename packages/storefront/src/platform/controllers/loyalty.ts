// Brand views, plan §2.3 `checkout.loyalty-redemption`: the checkout route owns the redemption signal and the loyalty fetch; the
// slot (and the base LoyaltyRedeem, which gets the same props) receives a detached projection and can only ask `onRedeemToggle$`.
// The pure functions below are the whole decision logic and are unit-tested; `useLoyaltyOffer` wires them to Qwik state.
import { $, useComputed$, useContext, useSignal, useStore, useTask$, useVisibleTask$, type ReadonlySignal, type Signal } from '@qwik.dev/core';
import { APP_STATE, CUSTOMER_NOT_DEFINED_ID } from '~/constants';
import { previewRedemption, srAccountLoyalty, type SrLoyaltyProgram } from '~/utils/sellright';
import { ACTION_RESULTS, dispatch, type ActionCtl } from './callbacks';
import type { ActionResult } from '~/platform/views';
import type { SlotProps } from '~/components/slots/registry';

/** What the checkout keeps of the shopper's loyalty account (JSON-shaped, serialisable). */
export interface LoyaltyAccount {
	/** srAccountLoyalty().available. */
	available: number;
	program: SrLoyaltyProgram;
}

export type LoyaltyViewData = Omit<SlotProps<'checkout.loyalty-redemption'>, 'onRedeemToggle$'>;

/** The offer: redeem everything available that the discountable amount allows (null = nothing redeemable). */
export const offerFor = (account: LoyaltyAccount, discountableCents: number) =>
	previewRedemption(account.available, account.available, discountableCents, account.program);

/** `null` for a guest or a program that is off: the control is not rendered. */
export function buildLoyaltyView(account: LoyaltyAccount | null, redeemPoints: number, discountableCents: number, currencyCode: string): LoyaltyViewData | null {
	if (!account) return null;
	const offer = offerFor(account, discountableCents);
	const applied = redeemPoints > 0 ? previewRedemption(redeemPoints, account.available, discountableCents, account.program) : null;
	return {
		balance: account.available,
		minRedeemPoints: account.program.minRedeemPoints,
		offer: offer ? { points: offer.points, discountCents: offer.discountCents } : null,
		applied: applied ? { points: applied.points, discountCents: applied.discountCents } : null,
		discountableCents,
		currencyCode,
	};
}

/**
 * A changed `discountableCents` recomputes the offer; an applied redemption above the new offer is reset to the new offer's points,
 * or 0 when nothing is redeemable any more. Returns the redemption to hold (unchanged when still valid).
 */
export function reconcileRedemption(account: LoyaltyAccount | null, current: number, discountableCents: number): number {
	if (current <= 0) return 0;
	if (!account) return current;
	const offer = offerFor(account, discountableCents);
	if (!offer) return 0;
	return current > offer.points ? offer.points : current;
}

/** The toggle decision: `on` with no offer is invalid (no state change); `off` always sets 0. */
export function decideToggle(account: LoyaltyAccount | null, on: boolean, discountableCents: number): { result: ActionResult; points: number | null } {
	if (!on) return { result: { ok: true }, points: 0 };
	const offer = account ? offerFor(account, discountableCents) : null;
	if (!offer) return { result: { ok: false, reason: 'invalid' }, points: null };
	return { result: { ok: true }, points: offer.points };
}

/** A customer id from the layout's auth state that names a signed-in shopper (the guest placeholder or none is not one). */
export const isSignedIn = (customerId: string | null | undefined): boolean => !!customerId && customerId !== CUSTOMER_NOT_DEFINED_ID;

export interface LoyaltyOffer {
	/** Null until the account is read, for a guest, or when the program is off. */
	view: ReadonlySignal<LoyaltyViewData | null>;
	onRedeemToggle$: (on: boolean) => Promise<ActionResult>;
}

/**
 * Called once by the checkout route. Reads the account in the browser (as the base control always did), keeps `redeemPoints` valid as
 * the discountable amount changes, and exposes the projection and the toggle. Only this hook writes `redeemPoints`.
 */
export function useLoyaltyOffer(redeemPoints: Signal<number>, discountableCents: Signal<number>, currencyCode: Signal<string>) {
	const account = useSignal<LoyaltyAccount | null>(null);
	const ctl = useStore<ActionCtl>({ disposed: false, admitted: [] });
	const appState = useContext(APP_STATE);

	useVisibleTask$(async ({ cleanup, track }) => {
		cleanup(() => { ctl.disposed = true; });
		// #400: a guest has no points: never ask (the API answered 401 on every guest checkout). Signing in on the page
		// (login modal) re-reads.
		const customerId = track(() => appState.customer?.id);
		if (!isSignedIn(customerId)) { account.value = null; return; }
		try {
			const data = await srAccountLoyalty();
			account.value = data.program.enabled ? { available: data.available, program: data.program } : null;
		} catch {
			account.value = null; // guest (401) or unavailable → no control
		}
	});

	useTask$(({ track }) => {
		const d = track(() => discountableCents.value);
		const a = track(() => account.value);
		const next = reconcileRedemption(a, redeemPoints.value, d);
		if (next !== redeemPoints.value) redeemPoints.value = next;
	});

	const view = useComputed$(() => buildLoyaltyView(account.value, redeemPoints.value, discountableCents.value, currencyCode.value));

	const onRedeemToggle$ = $((on: boolean) =>
		dispatch<ActionResult>(ctl, null, ACTION_RESULTS, () => {
			const { result, points } = decideToggle(account.value, on, discountableCents.value);
			if (points !== null) redeemPoints.value = points;
			return result;
		}),
	);
	return { view, onRedeemToggle$ };
}
