import { describe, expect, it, vi } from 'vitest';
import type { PaymentMethod, ResumeOutcome, ResumeView } from '~/hooks/useCheckout';
import type { ShopConfig } from '~/sellright/types/checkout';
import { beginResumeFlow, cancelResumeFlow, type ResumeFlowDeps } from './resume-flow';

/**
 * The real resume handler (resume-flow.ts, what the checkout route runs) driven with deferred provider responses: every
 * `resumeConverted` call is a promise the test settles by hand, and the test counts the requests it makes.
 */
const CONFIG = { stripeConfigured: true, gateways: { nmi: {}, sezzle: {} } } as unknown as ShopConfig;

const setup = () => {
	const requests: Array<{ method: PaymentMethod | null; settle: (outcome: ResumeOutcome) => void }> = [];
	const navigate = vi.fn();
	const deps: ResumeFlowDeps = {
		queue: { busy: false, pending: null, epoch: 0 },
		view: { gen: 0, failed: false },
		srState: { error: null, resume: 'none' as ResumeView, receiptToken: 'rt1', code: 'ORD-1' },
		state: { loading: true },
		selectedMethod: () => 'stripe',
		token: () => 'cart-token',
		ensureShopConfig: async () => CONFIG,
		resumeConverted: (_token, method) =>
			new Promise<ResumeOutcome>((resolve) => {
				requests.push({ method, settle: resolve });
			}),
		navigate,
	};
	const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
	return { deps, requests, navigate, tick };
};

describe('resume flow with deferred responses', () => {
	it('latest selection wins: the queued method is requested once the in-flight request settles', async () => {
		const { deps, requests, tick } = setup();
		const first = beginResumeFlow(deps, 'nmi');
		await tick();
		expect(requests.map((r) => r.method)).toEqual(['nmi']);
		const second = beginResumeFlow(deps, 'sezzle'); // lands while the first request is pending
		await second;
		expect(deps.queue.pending).toBe('sezzle');
		requests[0].settle('superseded'); // the click that queued it also superseded the first run
		await tick();
		expect(requests.map((r) => r.method)).toEqual(['nmi', 'sezzle']);
		requests[1].settle('payable');
		await first;
		expect(deps.queue).toEqual({ busy: false, pending: null, epoch: 0 });
		expect(deps.state.loading).toBe(false);
	});

	it('leaving checkout with a queued selection: the in-flight request completing starts no further request and navigates nowhere', async () => {
		const { deps, requests, navigate, tick } = setup();
		const first = beginResumeFlow(deps, 'nmi');
		await tick();
		await beginResumeFlow(deps, 'sezzle'); // queued behind the in-flight request
		expect(deps.queue.pending).toBe('sezzle');
		cancelResumeFlow(deps.view, deps.queue); // the page is left: the route's cleanup
		const genAfterLeaving = deps.view.gen;
		expect(deps.queue.pending).toBeNull();
		// The stale run's response arrives (it would settle the order and send the shopper to confirmation).
		deps.srState.resume = 'settled';
		requests[0].settle('settled');
		await first;
		await tick();
		expect(requests).toHaveLength(1); // no request for the queued 'sezzle'
		expect(navigate).not.toHaveBeenCalled();
		expect(deps.view.gen).toBe(genAfterLeaving); // no new generation was started after the page was left
		expect(deps.queue).toMatchObject({ busy: false, pending: null });
	});

	it('leaving checkout before a second selection lands: the second call after cancel is the only thing that can start a run', async () => {
		const { deps, requests, tick } = setup();
		const first = beginResumeFlow(deps, 'nmi');
		await tick();
		cancelResumeFlow(deps.view, deps.queue);
		requests[0].settle('payable');
		await first;
		// a later, deliberate resume (a new visit) still works: the cancel did not poison the queue
		const again = beginResumeFlow(deps, 'stripe');
		await tick();
		expect(requests.map((r) => r.method)).toEqual(['nmi', 'stripe']);
		requests[1].settle('payable');
		await again;
	});

	it('a settled order discovered by the current run navigates to its confirmation exactly once', async () => {
		const { deps, requests, navigate, tick } = setup();
		const run = beginResumeFlow(deps);
		await tick();
		requests[0].settle('settled');
		await run;
		expect(navigate).toHaveBeenCalledTimes(1);
		expect(navigate).toHaveBeenCalledWith('/checkout/confirmation/ORD-1?rt=rt1');
	});
});
