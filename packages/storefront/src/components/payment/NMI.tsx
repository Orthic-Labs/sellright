import { component$, useSignal, useVisibleTask$, type QRL, type Signal } from '@qwik.dev/core';
import { loadCollectJs, prepareCardTokenization, cardFieldHint, type CardBrand, type CardField, type TokenCard } from '~/services/NmiCollect';
import { ValidationIcon } from '~/components/checkout/ValidationIcon';
import { CardBrandIcon } from './CardBrandIcons';
import { startGatewayPayment } from '~/providers/shop/checkout/checkout';
import type { GatewayAttempt } from '~/sellright/types/checkout';
import { SellRightError } from '~/sellright/client';
import { nextConfirm } from './confirm-trigger';
import type { PayableOrder } from '~/components/checkout/payable-order';

/**
 * Generic card-gateway payment (NMI via Collect.js). Same imperative,
 * browser-only shape as `StripePaymentElement`: hosted iframes replace the
 * raw card inputs (Collect.js never lets a PAN reach this app), tokenize on
 * `confirmTrigger`, then charge via the native gateway-payment API.
 *
 * One Idempotency-Key per PAY submit (per tokenized card): the API replays a known key, so a key shared across
 * submits would make every PAY after a decline return the same decline and the shopper could never pay with
 * another card. A second trigger while a submit is still in flight (double click) is the SAME attempt and is
 * dropped, so one click's key is never used by two requests.
 *
 * #372: the fields mount before the order exists. With `ensureOrder$`, PAY tokenizes first (an invalid card never
 * creates an order), then asks the page for the order (created on the first PAY), then charges it.
 */
export interface NMIProps {
	/** The order to charge; '' before it exists (then `ensureOrder$` supplies it at PAY). */
	code: string;
	tokenizationKey: string;
	mode: 'test' | 'live';
	environment: 'sandbox' | 'production';
	receiptToken?: string;
	/** Flip (increment) to trigger tokenization + charge. */
	confirmTrigger: Signal<number>;
	/** The route's view generation when this component was rendered; every callback carries it so a stale mount is rejected. */
	mountGen?: number;
	onError$: QRL<(message: string, mountGen?: number) => void>;
	/** Collect.js could not be LOADED/mounted — distinct from a declined card; falls back to `onError$`. */
	onInitError$?: QRL<(message: string, mountGen?: number) => void>;
	onProcessingChange$?: QRL<(processing: boolean, mountGen?: number) => void>;
	onSuccess$: QRL<(result: GatewayAttempt) => void>;
	/** #372: the order to charge, created on the first PAY; null = stop without charging. */
	ensureOrder$?: QRL<() => Promise<PayableOrder | null>>;
	/** The hosted fields are usable (true) or gone (false, on unmount): the page keeps PLACE ORDER disabled until true. */
	onReadyChange$?: QRL<(ready: boolean) => void>;
}

/** What the hosted fields have reported so far; a field with no entry has not been interacted with (nothing shown). */
type FieldFeedback = Partial<Record<CardField, { valid: boolean; message: string }>>;

const FIELD_BORDER = '1px solid rgba(100,85,65,0.2)';
const FIELD_BORDER_INVALID = '1px solid #fca5a5';

export const NMI = component$<NMIProps>((props) => {
	const idPrefix = useSignal(`nmi-${Math.random().toString(36).slice(2)}`);
	const ready = useSignal(false);
	// This component's own mount id: captured once (the body re-runs on re-render, `useSignal` keeps the first value).
	const mountGen = useSignal(props.mountGen);
	const collectRef = useSignal<unknown>(null);
	const getTokenRef = useSignal<unknown>(null);
	// #393: brand + last 4 of the card just tokenized (from Collect.js's callback), sent with the token for the receipt.
	const tokenCard = useSignal<TokenCard | null>(null);
	const submitting = useSignal(false);
	// Per-field feedback from Collect.js's validationCallback, and the brand from its card lookup (shown once the number validates).
	const feedback = useSignal<FieldFeedback>({});
	const brand = useSignal<CardBrand | null>(null);
	// Baseline = the parent's signal at mount: it survives payment-method switches, so a stale confirm must not replay.
	const handledTrigger = useSignal(props.confirmTrigger.value);

	// Set when the component is removed (payment method switched while Collect.js was still loading). Every async
	// callback checks it: a late load/timeout failure from a dead component must not report into the shared
	// payment-init state, and a late "fields ready" must not touch a gone view.
	const disposed = useSignal(false);

	useVisibleTask$(async ({ cleanup }) => {
		cleanup(() => {
			disposed.value = true;
			void props.onReadyChange$?.(false);
		});
		const reportInitError = async (message: string) => {
			if (disposed.value) return;
			await (props.onInitError$ ?? props.onError$)(message, mountGen.value);
		};
		try {
			const collect = await loadCollectJs(props.tokenizationKey, props.mode, undefined, props.environment);
			if (disposed.value) return;
			collectRef.value = collect as unknown;
			const getToken = prepareCardTokenization(
				collect,
				{
					ccnumber: `#${idPrefix.value}-number`,
					ccexp: `#${idPrefix.value}-exp`,
					cvv: `#${idPrefix.value}-cvv`,
				},
				() => {
					if (!disposed.value) ready.value = true;
					if (!disposed.value) void props.onReadyChange$?.(true);
				},
				(message) => { void reportInitError(message); },
				{
					onTokenCard: (card) => { tokenCard.value = card; },
					onFieldValidation: (field, valid, message) => {
						if (!disposed.value) feedback.value = { ...feedback.value, [field]: { valid, message } };
					},
					onCardBrand: (next) => {
						if (!disposed.value) brand.value = next;
					},
				},
			);
			getTokenRef.value = getToken as unknown;
		} catch (e) {
			await reportInitError(e instanceof Error ? e.message : 'Card payment failed to load.');
		}
	}, { strategy: 'document-ready' }); // mount Collect.js as soon as the form renders, not on first intersection/interaction

	useVisibleTask$(async ({ track }) => {
		const t = track(() => props.confirmTrigger.value);
		// A confirm that arrives before the fields are ready is held, not dropped: it runs once they are.
		const isReady = track(() => ready.value);
		if (disposed.value) return;
		const decision = nextConfirm(t, isReady, handledTrigger.value);
		if (!decision.run) return;
		handledTrigger.value = decision.baseline;
		if (submitting.value) return; // double click: the attempt already in flight is this one
		const getToken = getTokenRef.value as (() => Promise<string>) | null;
		if (!getToken) {
			await props.onError$('Payment is not ready yet.', mountGen.value);
			return;
		}
		submitting.value = true;
		let processing = false;
		try {
			// The card is tokenized (and validated) before any order exists; a bad card stops here with its own message.
			tokenCard.value = null;
			const token = await getToken();
			const card = tokenCard.value;
			if (disposed.value) return; // the component is gone: no charge on behalf of a removed view
			let code = props.code;
			let receiptToken = props.receiptToken;
			if (props.ensureOrder$) {
				const order = await props.ensureOrder$();
				if (!order || disposed.value) return;
				code = order.code;
				receiptToken = order.receiptToken || undefined;
			}
			processing = true;
			await props.onProcessingChange$?.(true, mountGen.value);
			const result = await startGatewayPayment(code, 'nmi', {
				token,
				...(card ? { card } : {}),
				idempotencyKey: crypto.randomUUID(), // a new card submit is a new attempt
				receiptToken,
			});
			if (result.status === 'settled') {
				// The charge happened: the success must always be reported, even if the view is gone.
				await props.onSuccess$(result);
			} else if (!disposed.value) {
				await props.onError$('The card was declined. Please try a different card.', mountGen.value);
			}
		} catch (e) {
			if (disposed.value) return;
			const message = e instanceof SellRightError ? e.message : (e instanceof Error ? e.message : 'Card payment failed.');
			await props.onError$(message, mountGen.value);
		} finally {
			submitting.value = false;
			if (processing && !disposed.value) await props.onProcessingChange$?.(false, mountGen.value);
		}
	});

	// The bordered box is the wrapper: the hosted-field element inside it (which Collect.js fills with its iframe) keeps
	// static props so re-rendering the feedback never touches it.
	const box = (field: CardField, pr = 36) => {
		const state = feedback.value[field];
		return `position:relative;height:42px;border:${state && !state.valid ? FIELD_BORDER_INVALID : FIELD_BORDER};border-radius:4px;padding:0 ${pr}px 0 10px;background:#fff;transition:border-color 0.2s;`;
	};
	const icon = (field: CardField) => {
		const state = feedback.value[field];
		return <ValidationIcon touched={!!state} error={state && !state.valid ? cardFieldHint(field, state.message) : ''} valid={!!state?.valid} errorId={`${idPrefix.value}-${field}-error`} />;
	};
	const hostStyle = 'height:100%;display:flex;align-items:center;';

	return (
		<div class="nmi-card-form" style="display:flex;flex-direction:column;gap:12px;">
			<div>
				<span aria-hidden="true" class="nmi-label" style="display:block;font-size:12px;margin-bottom:4px;color:var(--color-ink-soft,#6b6359);">Card number</span>
				<div style={box('ccnumber', brand.value ? 72 : 36)}>
					<div id={`${idPrefix.value}-number`} class="nmi-field" style={hostStyle} />
					{brand.value && (
						<div data-testid="card-brand" style="position:absolute;right:34px;top:50%;transform:translateY(-50%);pointer-events:none;">
							<CardBrandIcon brand={brand.value} />
						</div>
					)}
					{icon('ccnumber')}
				</div>
			</div>
			<div style="display:flex;gap:12px;">
				<div style="flex:1;">
					<span aria-hidden="true" class="nmi-label" style="display:block;font-size:12px;margin-bottom:4px;color:var(--color-ink-soft,#6b6359);">Expiration</span>
					<div style={box('ccexp')}>
						<div id={`${idPrefix.value}-exp`} class="nmi-field" style={hostStyle} />
						{icon('ccexp')}
					</div>
				</div>
				<div style="flex:1;">
					<span aria-hidden="true" class="nmi-label" style="display:block;font-size:12px;margin-bottom:4px;color:var(--color-ink-soft,#6b6359);">Security code</span>
					<div style={box('cvv')}>
						<div id={`${idPrefix.value}-cvv`} class="nmi-field" style={hostStyle} />
						{icon('cvv')}
					</div>
				</div>
			</div>
			<div style="display:flex;align-items:center;justify-content:center;gap:6px;">
				<svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" style="color:rgba(140,107,58,0.6);">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M12 11c1.1 0 2-.9 2-2V7a2 2 0 00-4 0v2c0 1.1.9 2 2 2zm6 0h-1V9a5 5 0 10-10 0v2H6a2 2 0 00-2 2v5a2 2 0 002 2h12a2 2 0 002-2v-5a2 2 0 00-2-2z" />
				</svg>
				<span style="font-size:11px;font-weight:500;color:rgba(100,85,65,0.55);">Secure Credit Card Processing</span>
			</div>
		</div>
	);
});

export default NMI;
