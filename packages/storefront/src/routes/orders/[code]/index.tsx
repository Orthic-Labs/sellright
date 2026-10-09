import { $, component$, useSignal, useStore, useStyles$, useVisibleTask$ } from '@qwik.dev/core';
import { Link, useLocation } from '@qwik.dev/router';
import { StripePaymentElement } from '~/components/checkout/StripePaymentElement';
import NMI from '~/components/payment/NMI';
import Sezzle from '~/components/payment/Sezzle';
import { createPaymentIntent, getOrder, getShopConfig, verifyGatewayPayment } from '~/providers/shop/checkout/checkout';
import { settleStripeBalance } from '~/providers/shop/orders/balance';
import { getMe } from '~/services/customer';
import { SellRightError } from '~/sellright/client';
import type { OrderSummary, ShopConfig } from '~/sellright/types/checkout';
import {
	alreadyPaidCents, availableBalanceMethods, balancePageState, balanceReturnUrl, receiptTokenFrom, reconcileBalance, stripeReturnFrom,
	type BalanceMethod,
} from '~/utils/balance-pay';
import { formatPrice } from '~/utils';
import { createSEOHead } from '~/utils/seo';
import { useStoreIdentityLoader } from '~/routes/layout';

/**
 * Order-balance pay page. The "balance due" email (sent after an admin edited
 * an order up in price) links here: /orders/{code}?rt=<receiptToken>&pay=balance.
 *
 * Access is the SAME receipt-token scope as the confirmation page
 * (x-receipt-token / ?rt=) — no new public data. The API charges exactly the
 * amount due; the browser never sends an amount. Everything shown is read
 * from the order (amountDue + the latest edit's customer-safe change list),
 * and payment goes through whichever gateways the store has enabled
 * (GET /v1/shop/config): Stripe, NMI card or Sezzle. Stripe mints a PaymentIntent
 * for the amount due, redirects back here and is settled + reconciled on return.
 */

// The shared Sezzle component renders its own `.checkout-cta` button; style it
// here (the checkout route's stylesheet is not loaded on this page).
const BALANCE_STYLES = `.sr-balance .checkout-cta{display:block;width:100%;background:var(--color-ink);color:var(--color-ink-contrast);height:50px;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;border-radius:3px;border:none;font-weight:500;cursor:pointer;transition:opacity .2s}.sr-balance .checkout-cta:hover{opacity:.88}.sr-balance .checkout-cta:disabled{opacity:.5;cursor:not-allowed}`;

const LINK =
	'inline-flex items-center text-[13px] tracking-[0.12em] uppercase text-[var(--color-ink)] border-b border-[var(--color-ink)] pb-0.5 hover:opacity-70 transition-opacity';
const LABEL = 'font-mono text-[13px] tracking-[0.14em] uppercase text-[var(--color-ink-soft)]';
const TAB =
	'pb-2 mr-6 text-[13px] tracking-[0.08em] uppercase bg-transparent border-b-2 -mb-px cursor-pointer';

export const head = ({ params, resolveValue }: { params: { code: string }; resolveValue: any }) => {
	const identity = resolveValue(useStoreIdentityLoader);
	return createSEOHead({
		title: 'Pay Order Balance',
		description: `Pay the balance on your ${identity.storeName} order${params?.code ? ' #' + params.code : ''}.`,
		noindex: true,
		identity,
	});
};

export default component$(() => {
	useStyles$(BALANCE_STYLES);
	const loc = useLocation();
	const { code } = loc.params;
	const state = useStore<{
		loading: boolean;
		order?: OrderSummary;
		config?: ShopConfig;
		errorStatus?: number;
		justPaid: boolean;
		method: BalanceMethod | '';
		formError: string;
		processing: boolean;
		/** Stripe: client secret of the intent minted for the amount shown. */
		clientSecret: string;
		intentShownDue: number;
		/** The confirmed PaymentIntent awaiting reconciliation (payment stays locked while set). */
		intentId: string;
		reconciling: boolean;
		/** The last reconcile round got no answer at all, as opposed to a clean 'still processing'. */
		unknown: boolean;
	}>({ loading: true, justPaid: false, method: '', formError: '', processing: false, clientSecret: '', intentShownDue: 0, intentId: '', reconciling: false, unknown: false });
	const nmiTrigger = useSignal(0);
	const stripeTrigger = useSignal(0);

	// Re-read the order (and gateway config once). Sezzle can send the shopper
	// back here with ?paymentAttempt=<id>: verify that attempt first so a
	// shopper who just paid never sees a stale "amount due".
	const load = $(async (afterPayment: boolean, signal?: AbortSignal) => {
		const rt = receiptTokenFrom(loc.url.searchParams);
		if (!rt) {
			// A pay link (`?pay=balance`) that lost its receipt token is simply broken: say so, show nothing. The BARE
			// /orders/{code} link, though, is what every order email carries, and it has no token by design — so instead
			// of a dead end, send the shopper where they can see the order: their account when signed in, otherwise the
			// order-tracking lookup with the number filled in (they confirm the checkout email there).
			if (loc.url.searchParams.get('pay') === 'balance') {
				state.loading = false;
				return;
			}
			const me = await getMe().catch(() => null);
			window.location.replace(me ? `/account/orders/${encodeURIComponent(code)}` : `/track-order?orderCode=${encodeURIComponent(code)}`);
			return;
		}
		try {
			const attempt = loc.url.searchParams.get('paymentAttempt');
			if (attempt && !afterPayment) {
				try {
					await verifyGatewayPayment(code, attempt, rt, signal);
				} catch (e) {
					if (signal?.aborted) return;
					console.warn('[BalancePay] gateway verify on return failed (re-reading order):', e);
				}
			}
			const order = await getOrder(code, rt, signal);
			if (signal?.aborted) return;
			state.order = order;
			state.errorStatus = undefined;
			if (!state.config) {
				state.config = await getShopConfig();
				if (signal?.aborted) return;
				const methods = availableBalanceMethods(state.config);
				if (!state.method && methods[0]) state.method = methods[0];
			}
			// Landing back from Sezzle with nothing due means the attempt settled.
			if (attempt && !afterPayment && (order.amountDue ?? 0) <= 0 && order.state !== 'PendingPayment') state.justPaid = true;
		} catch (e) {
			if (signal?.aborted) return;
			state.errorStatus = e instanceof SellRightError ? e.status : 0;
		} finally {
			if (!signal?.aborted) state.loading = false;
		}
	});

	/**
	 * One bounded reconcile round for a confirmed Stripe intent (settle, then read
	 * until the balance clears). A round that ends without an answer holds the page
	 * with an explicit Refresh control; payment stays locked while an intent is
	 * unresolved so a retry can never become a duplicate charge.
	 */
	const settleAndWait = $(async (intentId: string, rt: string, signal: AbortSignal) => {
		state.processing = true;
		state.reconciling = true;
		state.intentId = intentId;
		state.unknown = false;
		const outcome = await reconcileBalance({
			settle: async () => { await settleStripeBalance(code, rt, intentId); },
			read: async () => {
				try {
					const o = await getOrder(code, rt, signal);
					state.order = o;
					return o.amountDue ?? 0;
				} catch {
					return null;
				}
			},
			statusOf: (e) => (e instanceof SellRightError ? e.status : null),
			signal,
		});
		if (signal.aborted || outcome === 'aborted') return;
		state.reconciling = false;
		if (outcome === 'cleared') {
			state.processing = false;
			state.justPaid = true;
			state.intentId = '';
		} else if (outcome === 'failed') {
			// Definitive: the API says this intent did not pay. Safe to try again.
			state.processing = false;
			state.intentId = '';
			state.clientSecret = '';
			state.formError = 'Your payment was not completed. You have not been charged; please try again.';
		} else {
			state.processing = true;
			state.unknown = outcome === 'unknown';
		}
	});

	const refreshStatus = $(async () => {
		const rt = receiptTokenFrom(loc.url.searchParams);
		if (!rt || !state.intentId || state.reconciling) return;
		await settleAndWait(state.intentId, rt, new AbortController().signal);
	});

	useVisibleTask$(async ({ cleanup }) => {
		const ac = new AbortController();
		cleanup(() => ac.abort());
		await load(false, ac.signal);
		// Back from Stripe's redirect: pick the intent up from the query it appends.
		const back = stripeReturnFrom(loc.url.searchParams);
		const rt = receiptTokenFrom(loc.url.searchParams);
		if (back && rt && !ac.signal.aborted) {
			if (back.failed) state.formError = 'Your payment was not completed. You have not been charged; please try again.';
			else await settleAndWait(back.intentId, rt, ac.signal);
		}
	});

	// Stripe: mint the PaymentIntent for the amount the shopper is looking at.
	// Re-minted if that amount moves (the API keys intents on the amount due).
	useVisibleTask$(async ({ track, cleanup }) => {
		const method = track(() => state.method);
		const due = track(() => state.order?.amountDue ?? 0);
		const locked = track(() => state.intentId);
		const rt = receiptTokenFrom(loc.url.searchParams);
		if (method !== 'stripe' || !rt || due <= 0 || locked || state.justPaid) return;
		if (state.clientSecret && state.intentShownDue === due) return;
		let stale = false;
		cleanup(() => { stale = true; });
		try {
			const intent = await createPaymentIntent(code, rt);
			if (stale) return;
			state.clientSecret = intent.clientSecret;
			state.intentShownDue = due;
		} catch {
			if (!stale) state.formError = 'We could not start the payment. Please refresh the page and try again.';
		}
	});

	const onSuccess = $(async () => {
		// NMI settles synchronously: the API already verified the charge.
		state.justPaid = true;
		state.formError = '';
		await load(true);
	});
	const onError = $((message: string) => {
		state.formError = message;
	});
	const onProcessing = $((p: boolean) => {
		state.processing = p;
	});

	const payStripe = $(async () => {
		const rt = receiptTokenFrom(loc.url.searchParams);
		if (!rt || state.processing || !state.clientSecret) return;
		state.formError = '';
		// Never charge an amount the shopper has not seen: re-read, and stop if it moved.
		try {
			const fresh = await getOrder(code, rt);
			if ((fresh.amountDue ?? 0) !== state.intentShownDue) {
				state.order = fresh;
				state.formError = (fresh.amountDue ?? 0) > 0 ? 'The amount due has changed. Please review it and pay again.' : '';
				return;
			}
		} catch {
			state.formError = 'We could not check the amount due. Please try again.';
			return;
		}
		stripeTrigger.value++;
	});

	const rt = receiptTokenFrom(loc.url.searchParams);
	const view = state.loading
		? 'loading'
		: balancePageState({ hasToken: !!rt, order: state.order, errorStatus: state.errorStatus, justPaid: state.justPaid });
	const order = state.order;
	const due = order?.amountDue ?? 0;
	const currency = order?.currency;
	const methods = availableBalanceMethods(state.config);
	const change = order?.balanceChange;
	const nmi = state.config?.gateways?.nmi;
	const stripeKey = state.config?.stripePublishableKey?.trim() || '';

	return (
		<div class="sr-balance bg-[var(--color-parchment)] min-h-screen">
			<div class="max-w-2xl mx-auto pt-10 sm:pt-14 pb-24 px-6">
				{view === 'loading' && (
					<div class="animate-pulse text-center" aria-busy="true">
						<div class="h-10 bg-[var(--color-card-border)] rounded w-72 mx-auto mb-4" />
						<div class="h-4 bg-[var(--color-card-border)] rounded w-56 mx-auto" />
					</div>
				)}

				{(view === 'invalid' || view === 'unavailable' || view === 'not-payable') && (
					<div class="text-center" data-testid="balance-state-error">
						<h1 class="font-display text-4xl text-[var(--color-ink)] mb-3" style="line-height: 1.1">
							{view === 'invalid' && 'This payment link is not valid'}
							{view === 'unavailable' && 'We could not load your order'}
							{view === 'not-payable' && 'No balance to pay here'}
						</h1>
						<p class="text-[var(--color-ink-soft)] text-[14px] mb-8 max-w-md mx-auto">
							{view === 'invalid' &&
								'The link may have expired or been copied incompletely. Open the most recent email about your order and use the button in it, or contact us and we will help.'}
							{view === 'unavailable' && 'Something went wrong on our side. Please try again in a moment.'}
							{view === 'not-payable' && 'This order does not have a balance that can be paid on this page.'}
						</p>
						<Link href="/contact" class={LINK}>Contact us</Link>
					</div>
				)}

				{(view === 'settled' || view === 'nothing-due') && order && (
					<div class="text-center" data-testid={`balance-state-${view}`}>
						<svg class="w-10 h-10 mx-auto text-[var(--color-accent)] mb-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true">
							<circle cx="12" cy="12" r="10" />
							<path stroke-linecap="round" stroke-linejoin="round" d="M8 12.5l2.5 2.5L16 9.5" />
						</svg>
						<h1 class="font-display text-4xl sm:text-5xl text-[var(--color-ink)] mb-3" style="line-height: 1.05">
							{view === 'settled' ? 'Balance paid, thank you' : 'Nothing left to pay'}
						</h1>
						<p class="text-[var(--color-ink-soft)] text-[14px] mb-8">
							Order <span class="font-medium text-[var(--color-ink)]">#{order.code}</span>{' '}
							{view === 'settled'
								? 'is now paid in full. We will email you if anything else changes.'
								: 'is paid in full. There is no outstanding balance.'}
						</p>
						<Link href={`/checkout/confirmation/${encodeURIComponent(order.code)}?rt=${encodeURIComponent(rt ?? '')}`} class={LINK}>
							View your order
						</Link>
					</div>
				)}

				{view === 'due' && order && (
					<div data-testid="balance-state-due">
						<div class="text-center mb-10">
							<p class={`${LABEL} mb-3`}>Order #{order.code}</p>
							<h1 class="font-display text-4xl sm:text-5xl text-[var(--color-ink)] mb-3" style="line-height: 1.05">Pay your balance</h1>
							<p class="text-[var(--color-ink-soft)] text-[14px] max-w-md mx-auto">
								Your order was updated and the new total is higher than what you paid. Pay the difference below.
							</p>
						</div>

						<div class="border border-[var(--color-card-border)] bg-white/60 rounded-[3px] p-6 mb-8">
							<div class="flex items-baseline justify-between">
								<span class="text-[14px] text-[var(--color-ink)]">Amount due</span>
								<span class="font-display text-3xl text-[var(--color-ink)] tabular-nums" data-testid="balance-amount">{formatPrice(due, currency)}</span>
							</div>
							<dl class="mt-4 pt-4 border-t border-[var(--color-card-border)] space-y-2 text-[13px] text-[var(--color-ink-soft)]">
								{change?.previousGrandTotal != null && (
									<div class="flex justify-between"><dt>Previous total</dt><dd class="tabular-nums">{formatPrice(change.previousGrandTotal, currency)}</dd></div>
								)}
								<div class="flex justify-between"><dt>New total</dt><dd class="tabular-nums">{formatPrice(order.grandTotal, currency)}</dd></div>
								<div class="flex justify-between"><dt>Already paid</dt><dd class="tabular-nums">{formatPrice(alreadyPaidCents(order.grandTotal, due), currency)}</dd></div>
							</dl>
						</div>

						{change && change.changes.length > 0 && (
							<div class="mb-8" data-testid="balance-changes">
								<h2 class={`${LABEL} mb-3`}>What changed</h2>
								<ul class="text-[14px] text-[var(--color-ink)] space-y-1.5 list-disc pl-5">
									{change.changes.map((c) => <li key={c}>{c}</li>)}
								</ul>
							</div>
						)}

						<div class="mb-8">
							<h2 class={`${LABEL} mb-3`}>Your order</h2>
							<ul class="divide-y divide-[var(--color-card-border)] border-y border-[var(--color-card-border)]">
								{order.lines.map((line) => (
									<li key={line.sku} class="py-3 flex justify-between gap-4 text-[14px]">
										<span class="min-w-0 truncate text-[var(--color-ink)]">{line.name} <span class="text-[var(--color-ink-soft)]">× {line.quantity}</span></span>
										<span class="tabular-nums text-[var(--color-ink)]">{formatPrice(line.lineTotal, currency)}</span>
									</li>
								))}
							</ul>
						</div>

						{state.intentId && (
							<div class="mb-4 text-center">
								<p class="text-[14px] text-[var(--color-ink)] mb-3" role="status" data-testid="balance-processing">
									{state.reconciling
										? 'Checking your payment…'
										: state.unknown
											? 'We could not confirm your payment status yet. Please do not pay again: use Refresh to check, or contact us.'
											: 'Your payment is still being processed. Please do not pay again: use Refresh to check, or contact us.'}
								</p>
								{!state.reconciling && (
									<button type="button" class="checkout-cta" data-testid="balance-refresh" onClick$={refreshStatus}>Refresh payment status</button>
								)}
							</div>
						)}

						{methods.length === 0 && (
							<p class="text-[14px] text-[var(--color-ink-soft)] text-center" data-testid="balance-no-methods">
								Online payment is not available right now. Please <Link href="/contact" class="underline">contact us</Link> to pay this balance.
							</p>
						)}

						{methods.length > 0 && (
							<div>
								{methods.length > 1 && (
									<div class="flex border-b border-[var(--color-card-border)] mb-5" role="tablist">
										{methods.includes('stripe') && (
											<button
												type="button" role="tab" aria-selected={state.method === 'stripe'}
												disabled={state.processing}
												onClick$={() => { state.method = 'stripe'; state.formError = ''; }}
												class={`${TAB} ${state.method === 'stripe' ? 'font-medium text-[var(--color-ink)] border-[var(--color-accent)]' : 'text-[var(--color-ink-soft)] border-transparent'}`}
											>
												Card
											</button>
										)}
										{methods.includes('nmi') && (
											<button
												type="button" role="tab" aria-selected={state.method === 'nmi'}
												disabled={state.processing}
												onClick$={() => { state.method = 'nmi'; state.formError = ''; }}
												class={`${TAB} ${state.method === 'nmi' ? 'font-medium text-[var(--color-ink)] border-[var(--color-accent)]' : 'text-[var(--color-ink-soft)] border-transparent'}`}
											>
												Credit / Debit Card
											</button>
										)}
										{methods.includes('sezzle') && (
											<button
												type="button" role="tab" aria-selected={state.method === 'sezzle'}
												disabled={state.processing}
												onClick$={() => { state.method = 'sezzle'; state.formError = ''; }}
												class={`${TAB} ${state.method === 'sezzle' ? 'font-medium text-[var(--color-ink)] border-[var(--color-accent)]' : 'text-[var(--color-ink-soft)] border-transparent'}`}
											>
												Pay in installments
											</button>
										)}
									</div>
								)}

								{state.method === 'stripe' && stripeKey && (
									<>
										{state.clientSecret && (
											<StripePaymentElement
												key={state.clientSecret}
												publishableKey={stripeKey}
												clientSecret={state.clientSecret}
												returnUrl={balanceReturnUrl(typeof location !== 'undefined' ? location.origin : '', order.code, rt ?? '')}
												confirmTrigger={stripeTrigger}
												onError$={onError}
												onProcessingChange$={onProcessing}
											/>
										)}
										<button
											type="button"
											class="checkout-cta mt-4"
											disabled={state.processing || !state.clientSecret}
											data-testid="balance-pay-button"
											onClick$={payStripe}
										>
											{state.processing ? 'Processing...' : `Pay ${formatPrice(due, currency)}`}
										</button>
									</>
								)}
								{state.method === 'nmi' && nmi && (
									<>
										<NMI
											code={order.code}
											tokenizationKey={nmi.tokenizationKey}
											mode={nmi.mode}
											environment={nmi.environment}
											receiptToken={rt}
											confirmTrigger={nmiTrigger}
											onError$={onError}
											onProcessingChange$={onProcessing}
											onSuccess$={onSuccess}
										/>
										<button
											type="button"
											class="checkout-cta mt-4"
											disabled={state.processing}
											data-testid="balance-pay-button"
											onClick$={() => {
												state.formError = '';
												nmiTrigger.value++;
											}}
										>
											{state.processing ? 'Processing...' : `Pay ${formatPrice(due, currency)}`}
										</button>
									</>
								)}
								{state.method === 'sezzle' && (
									<Sezzle
										code={order.code}
										receiptToken={rt}
										label={`Continue to Sezzle · ${formatPrice(due, currency)}`}
										disabled={state.processing}
										onError$={onError}
										onProcessingChange$={onProcessing}
									/>
								)}

								{state.formError && (
									<p class="text-[14px] text-red-700 mt-3" role="alert" data-testid="balance-error">{state.formError}</p>
								)}
							</div>
						)}

						<p class="text-[13px] text-[var(--color-ink-soft)] text-center mt-8">
							Questions? <Link href="/contact" class="underline underline-offset-2 hover:text-[var(--color-ink)]">Get in touch</Link>
						</p>
					</div>
				)}
			</div>
		</div>
	);
});
