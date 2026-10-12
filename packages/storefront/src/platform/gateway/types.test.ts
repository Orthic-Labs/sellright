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
	ShellFooterProps,
	ShellViewProps,
} from '~/platform/views';
import { ACTION_RESULT, FORM_RESULT } from './actions';
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
];

describe('gateway schemas match the prop types', () => {
	it('is checked at compile time (see CHECKS)', () => {
		expect(CHECKS.every(Boolean)).toBe(true);
	});
});
