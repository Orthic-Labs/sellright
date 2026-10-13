import type { PaymentMethod, ResumeOutcome, ResumeView } from '~/hooks/useCheckout';
import type { ShopConfig } from '~/sellright/types/checkout';
import { cancelResumes, drainResumes, type ResumeQueue } from './resume-selection';
import { bumpView, isCurrentView, type ViewGeneration } from './view-generation';

/**
 * Resume of the ORIGINAL order of a converted cart, as the checkout route runs it. It lives here (not inline in the
 * route) so the same code the page runs can be driven by tests with deferred provider responses. The route builds the
 * deps from its own stores and QRLs and calls `beginResumeFlow` / `cancelResumeFlow`.
 */
export interface ResumeFlowDeps {
	queue: ResumeQueue<PaymentMethod>;
	view: ViewGeneration & { failed: boolean };
	srState: { error: string | null; resume: ResumeView; receiptToken: string; code: string };
	state: { loading: boolean };
	selectedMethod: () => PaymentMethod;
	token: () => string | null | undefined;
	ensureShopConfig: (gen: number) => Promise<ShopConfig>;
	resumeConverted: (token: string, method: PaymentMethod | null, probe: boolean, isCurrent: () => boolean) => Promise<ResumeOutcome>;
	navigate: (path: string) => unknown;
}

/** One resume run. It starts a new view generation, so it must only be started by `beginResumeFlow`. */
export const runResumeFlow = async (deps: ResumeFlowDeps, methodOverride?: PaymentMethod, probe = false): Promise<void> => {
	const token = deps.token();
	if (!token) return;
	// A resume start replaces the view: it supersedes every handler still in flight.
	const gen = bumpView(deps.view);
	const current = () => isCurrentView(deps.view, gen);
	try {
		deps.view.failed = false;
		// The payment method needs the shop config: a failed config read is a retryable error, never a silent
		// "no payment method configured" (the Stripe key would be empty) for an order that is waiting to be paid.
		let cfg: ShopConfig;
		try {
			cfg = await deps.ensureShopConfig(gen);
		} catch (e) {
			if (!current()) return;
			console.warn('[Checkout] shop-config fetch failed:', e);
			deps.srState.error = "We couldn't load your payment options. Please try again.";
			deps.srState.resume = 'error';
			return;
		}
		if (!current()) return;
		const anyGatewayConfigured = !!cfg.stripeConfigured || !!cfg.gateways?.nmi || !!cfg.gateways?.sezzle;
		const view = await deps.resumeConverted(token, anyGatewayConfigured ? (methodOverride ?? deps.selectedMethod()) : null, probe, current);
		if (view === 'settled' && current()) {
			const rt = deps.srState.receiptToken ? `?rt=${encodeURIComponent(deps.srState.receiptToken)}` : '';
			deps.navigate(`/checkout/confirmation/${deps.srState.code}${rt}`);
		}
	} finally {
		// Only the current resume releases the controls; a superseding handler owns them.
		if (current()) deps.state.loading = false;
	}
};

/**
 * Entry point for every resume. A method chosen while a resume is still in flight is not dropped: the latest choice is
 * queued and applied once the in-flight run settles (see resume-selection.ts).
 */
export const beginResumeFlow = async (deps: ResumeFlowDeps, methodOverride?: PaymentMethod, probe = false): Promise<void> => {
	let firstRun = true;
	await drainResumes(deps.queue, methodOverride, (method) => {
		// `probe` belongs to the call that started the drain; a queued method selection is never a probe.
		const asProbe = firstRun && probe;
		firstRun = false;
		return runResumeFlow(deps, method, asProbe);
	});
};

/** The page was left: supersede the in-flight run and void every queued selection before anything else can start. */
export const cancelResumeFlow = (view: ViewGeneration, queue: ResumeQueue<PaymentMethod>): void => {
	bumpView(view);
	cancelResumes(queue);
};
