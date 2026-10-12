// Brand views, plan §2.3: the PUBLIC platform surface for brand code (layers.json platformApi.public). Prop and result types
// for the view slots, plus the few presentation primitives a brand may use. Every export is a type, a definition in
// src/platform/**, or a reviewed re-export named in layers.json platformApi.reexports (scripts/check-imports.mjs r5,
// proven by src/platform/public-surface.test.ts). Slot props are flat: DeepReadonly<ViewData> & Actions.
import type { QRL } from '@qwik.dev/core';
import { formatPrice } from '~/utils/price-format';

export { Link } from '@qwik.dev/router';
export { OptimizedImage } from '~/components/ui/LazyImage';
export { RichContent } from '~/platform/widgets/RichContent';
export { TurnstileMount } from '~/platform/widgets/TurnstileMount';
export { default as VerificationButton } from '~/components/verification/VerificationButton';
export type { SanitizedHtml } from '~/platform/sanitized';
import type { SanitizedHtml } from '~/platform/sanitized';

/** Pure money formatting for display (minor units in, locale string out). */
export const formatMoney = (cents: Cents, currencyCode?: string): string => formatPrice(cents, currencyCode);

export type Cents = number;

/** Arguments are primitives; the controller validates them against its own state before applying anything. */
export type ActionResult = { ok: true } | { ok: false; reason: 'invalid' | 'busy' | 'disposed' | 'error' };
export type Action<A extends unknown[] = [], R = ActionResult> = QRL<(...args: A) => Promise<R>>;

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
	? T
	: T extends readonly (infer U)[]
		? readonly DeepReadonly<U>[]
		: T extends object
			? { readonly [K in keyof T]: DeepReadonly<T[K]> }
			: T;

export interface PublicIdentity {
	storeName: string;
	legalName: string;
	tagline: string;
	supportEmail: string;
	logoText: string;
	logoImageUrl: string | null;
	siteOrigin: string;
	social: { instagram?: string; facebook?: string; twitter?: string; tiktok?: string; youtube?: string; pinterest?: string };
}

/** Sources: identity loader; useLocation(); appState.showCart/customer; cart lines (components/header/header.tsx). */
export interface ShellViewProps {
	identity: PublicIdentity;
	pathname: string;
	isHome: boolean;
	isCheckout: boolean;
	isConfirmation: boolean;
	isNavigating: boolean;
	cartQuantity: number;
	cartOpen: boolean;
	account: { signedIn: boolean; displayName: string | null };
	/** useCartToggle: opening the cart always runs the live stock refresh. */
	onCartToggle$: Action;
	onLogin$: Action;
	onLogout$: Action;
	onAccount$: Action;
}
export interface ShellFooterProps {
	identity: PublicIdentity;
	/** Provider-neutral labels from platform/payments/labels.ts. */
	paymentLabels: string[];
	year: number;
}

export interface ContentViewProps {
	identity: PublicIdentity;
	pageKey: string;
	pathname: string;
}

export interface FormState {
	status: 'idle' | 'submitting' | 'success' | 'error';
	message: string | null;
	turnstileRequired: boolean;
	turnstileReady: boolean;
}
export type FormResult = { ok: true } | { ok: false; reason: 'invalid' | 'busy' | 'turnstile' | 'server' | 'disposed' };

export interface ListingCard {
	slug: string;
	name: string;
	href: string;
	image: string | null;
	priceCents: Cents;
	currencyCode: string;
}

export interface HomeViewProps {
	identity: PublicIdentity;
	newsletter: FormState;
	featured: ListingCard[];
	onSubscribe$: Action<[email: string, honeypot: string], FormResult>;
}

export interface BlogCard {
	slug: string;
	title: string;
	excerpt: string | null;
	image: string | null;
	/** publishDate ?? createdAt; null = the view omits the date. */
	publishedAt: string | null;
	/** Minutes (adapter default 1). */
	readingTime: number;
	href: string;
	tags: string[];
}
export interface BlogListViewProps {
	identity: PublicIdentity;
	posts: BlogCard[];
	total: number;
	pageSize: number;
	hasMore: boolean;
}
export type BlogPostViewProps = { identity: PublicIdentity } & (
	| {
			state: 'found';
			post: {
				slug: string;
				title: string;
				excerpt: string | null;
				publishedAt: string | null;
				authorName: string | null;
				image: string | null;
				tags: string[];
				readingTime: number;
				/** Checked against the final sanitised body: every id exists in it. */
				toc: { id: string; text: string }[];
				body: SanitizedHtml;
			};
			related: BlogCard[];
	  }
	| { state: 'missing' }
);

export interface ContactViewProps {
	identity: PublicIdentity;
	form: FormState;
	onSubmit$: Action<[name: string, email: string, subject: string, message: string, honeypot: string], FormResult>;
}
