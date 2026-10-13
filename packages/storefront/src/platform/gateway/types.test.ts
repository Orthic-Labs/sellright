// Gateway plan §3: each handle schema describes exactly today's prop type (checked by `tsc`: a drift in either fails typecheck).
import { describe, expect, it } from 'vitest';
import type { SlotProps } from '~/components/slots/registry';
import type { LoyaltyViewData } from '~/platform/controllers/loyalty';
import type { AccountOrderSummary } from '~/sellright/types/account';
import type { LIVE } from '~/sellright/types/live';
import type {
	ActionResult,
	BlogListViewProps,
	BlogPostViewProps,
	ContactViewProps,
	ContentViewProps,
	DeepReadonly,
	FormResult,
	HomeViewProps,
	PublicIdentity,
	AddResult,
	ProductFoundData,
	ProductMissingData,
	ShopViewData,
	ShellFooterProps,
	ShellViewProps,
} from '~/platform/views';
import { ACTIONS, ACTION_RESULT, ADD_RESULT, FORM_RESULT, type ActionName, type BoundAction } from './actions';
import type {
	BLOG_LIST_DATA,
	BLOG_POST_DATA,
	CONTACT_DATA,
	CONTENT_DATA,
	FREE_SHIPPING_DATA,
	HOME_DATA,
	IDENTITY,
	LOYALTY_DATA,
	ORDER_SUMMARY,
	SHELL_FOOTER_DATA,
	SHELL_HEADER_DATA,
	SHOP_DATA,
	PRODUCT_FOUND_DATA,
	PRODUCT_MISSING_DATA,
} from './index';
import type { Infer } from './schema';

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Check<S, T> = Same<Infer<S>, DeepReadonly<T>>;
const yes = <T extends true>(v: T) => v;

// Each line fails to compile if the schema and the prop type disagree in any field, optionality or literal.
export const CHECKS = [
	yes<Check<typeof IDENTITY, PublicIdentity>>(true),
	yes<Check<typeof SHELL_HEADER_DATA, Omit<ShellViewProps, 'onCartToggle$' | 'onLogin$' | 'onLogout$' | 'onAccount$'>>>(true),
	yes<Check<typeof SHELL_FOOTER_DATA, ShellFooterProps>>(true),
	yes<Check<typeof HOME_DATA, Omit<HomeViewProps, 'onSubscribe$'>>>(true),
	yes<Check<typeof CONTENT_DATA, ContentViewProps>>(true),
	yes<Check<typeof BLOG_LIST_DATA, BlogListViewProps>>(true),
	yes<Check<typeof BLOG_POST_DATA, BlogPostViewProps>>(true),
	yes<Check<typeof CONTACT_DATA, Omit<ContactViewProps, 'onSubmit$'>>>(true),
	yes<Check<typeof FREE_SHIPPING_DATA, SlotProps<'cart.free-shipping-progress'>>>(true),
	yes<Check<typeof LOYALTY_DATA, LoyaltyViewData>>(true),
	yes<Check<typeof ORDER_SUMMARY, Omit<AccountOrderSummary, typeof LIVE>>>(true),
	yes<Check<typeof ACTION_RESULT, ActionResult>>(true),
	yes<Check<typeof FORM_RESULT, FormResult>>(true),
	yes<Check<typeof ADD_RESULT, AddResult>>(true),
	yes<Check<typeof SHOP_DATA, ShopViewData>>(true),
	yes<Check<typeof PRODUCT_FOUND_DATA, ProductFoundData>>(true),
	yes<Check<typeof PRODUCT_MISSING_DATA, ProductMissingData>>(true),
];

// Failure results: what presentation reads on a failed action must be the public contract's own (`reason`), for the value the gateway
// builds on a platform exception and for the type of every bound action. `FailureOf` is the fixed failure each action declares.
type RunResult<A> = A extends (...a: never[]) => infer R ? Awaited<R> : never;
type FailureOf<N extends ActionName> = (typeof ACTIONS)[N] extends { failure: infer F } ? F : undefined;
export const FAILURES = [
	// the bound action's result is exactly the public result type (so `r.reason` is typed and present on the failure branch)
	yes<Same<RunResult<BoundAction<'shell.cart-toggle'>>, DeepReadonly<ActionResult>>>(true),
	yes<Same<RunResult<BoundAction<'shell.login'>>, DeepReadonly<ActionResult>>>(true),
	yes<Same<RunResult<BoundAction<'shell.logout'>>, DeepReadonly<ActionResult>>>(true),
	yes<Same<RunResult<BoundAction<'shell.account'>>, DeepReadonly<ActionResult>>>(true),
	yes<Same<RunResult<BoundAction<'loyalty.redeem-toggle'>>, DeepReadonly<ActionResult>>>(true),
	yes<Same<RunResult<BoundAction<'pdp.waitlist-join'>>, DeepReadonly<ActionResult>>>(true),
	yes<Same<RunResult<BoundAction<'home.subscribe'>>, DeepReadonly<FormResult>>>(true),
	yes<Same<RunResult<BoundAction<'contact.submit'>>, DeepReadonly<FormResult>>>(true),
	yes<Same<RunResult<BoundAction<'configurator.add'>>, DeepReadonly<AddResult>>>(true),
	yes<Same<RunResult<BoundAction<'configurator.option-select'>>, DeepReadonly<ActionResult>>>(true),
	yes<FailureOf<'configurator.add'> extends AddResult ? true : false>(true),
	// the declared failure is a member of that public type
	yes<FailureOf<'shell.login'> extends ActionResult ? true : false>(true),
	yes<FailureOf<'home.subscribe'> extends FormResult ? true : false>(true),
	// a failure shaped like the old `{ ok: false, code, message }` is not an ActionResult / FormResult
	yes<{ ok: false; code: 'action-failed'; message: string } extends ActionResult ? false : true>(true),
	yes<{ ok: false; code: 'action-failed'; message: string } extends FormResult ? false : true>(true),
];

describe('gateway schemas match the prop types', () => {
	it('is checked at compile time (see CHECKS)', () => {
		expect(CHECKS.every(Boolean)).toBe(true);
	});
	it('failure results use the public contract (compile-time, see FAILURES)', () => {
		expect(FAILURES.every(Boolean)).toBe(true);
	});
});
