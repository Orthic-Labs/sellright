// Removed LoadingSpinner - using SSR data instead of loading states
import {
	$,
	Slot,
	component$,
	useContextProvider,
	useOn,
	useOnDocument,
	useStore,
	useTask$,
} from '@qwik.dev/core';
import { isBrowser } from '@qwik.dev/core/build';
import { RequestHandler, routeLoader$, useLocation } from '@qwik.dev/router';
import { ImageTransformerProps, useImageProvider } from 'qwik-image';
import Menu from '~/components/menu/Menu';
import { APP_STATE, IMAGE_RESOLUTIONS, COUNTRY_COOKIE } from '~/constants';
import { ActiveCustomer, AppState } from '~/types';
import ConditionalCart from '../components/cart/ConditionalCart';
import Header from '../components/header/header';
import Footer from '../components/footer/footer';
import { BrandFooterMount, BrandHeaderMount } from '~/platform/controllers/shell';
import { hasView, ComingSoon, MaintenanceScreen } from '~/platform/gateway';
import { CartProvider } from '~/contexts/CartContext';
import { LoginModalProvider, useLoginModalState, useLoginModalActions } from '~/contexts/LoginModalContext';
import LoginModal from '~/components/auth/LoginModal';
import { LocalAddressService } from '~/services/LocalAddressService';
import { CountryPreferenceService } from '~/services/CountryPreferenceService';
import { CACHE_POLICY_VERSION, resolveRouteCacheProfile, vetoEdgeCache } from '~/config/route-cache-policy';
import { sellright } from '~/sellright/client';
import { srShopIdentity, srErrorStatus, type SrMaintenanceStatus } from '~/utils/sellright';
import { identityFromStaticTheme } from '~/theme/theme.config';
import { normalizeIdentity } from '~/utils/normalize-identity';
import { AnalyticsMount } from '~/platform/controllers/analytics-mount';
import { BRAND_HEAD } from '~/platform/brand-data';
import { canRestorePreferredCountry } from '~/components/checkout/checkout-country';
import { anonymousCustomer, fetchSessionCustomer, nextCustomer } from '~/utils/session-customer';
import { getCookie } from '~/utils';
import { enablePostPaintEffects } from '~/utils/post-paint-fx';
import { CartService } from '~/services/CartService';

/** head.json analytics declared (a build constant): only then is the conversion subscriber mounted. */
const HAS_ANALYTICS = !!BRAND_HEAD.analytics;

/** WS-C: cookie that remembers a valid preview token across navigation, once
 *  presented on any request via ?preview_token=. Not HttpOnly — the value is
 *  only useful to identify a link-holder as trusted, never a session secret;
 *  keeping it readable also lets client nav propagate it if ever needed. */
const PREVIEW_TOKEN_COOKIE = 'sr_preview_token';

/** Set by GET /api/session/ while HttpOnly legacy transport exists (see ~/utils/session-customer.server.ts). */
const LEGACY_HINT = /(?:^|;\s*)sr_legacy_cart=1(?:;|$)/;

/**
 * Runtime store identity/theme (plan §1.9): fetched fresh per request from
 * the API, resolved by the request's own Host — this is what makes one built
 * storefront image servable for any store. Falls back to the build-time
 * `theme` object (theme.config.ts, itself VITE_*-driven) only when the API
 * call fails for a reason OTHER than "store not published" — i.e. treats
 * network/API-down as an offline/dev fallback, never as a way to bypass the
 * publish gate.
 *
 * `notPublished: true` tells the layout to render the private-preview
 * "coming soon" page instead of the real storefront chrome (plan §1.5): an
 * unpublished store, viewed by someone without a valid preview token.
 */
export const useStoreIdentityLoader = routeLoader$(async ({ cookie, query, status, headers }) => {
	const queryToken = query.get('preview_token') ?? undefined;
	if (queryToken) {
		vetoEdgeCache(headers, 'preview');
		// Persist it (30 days) so following the link once is enough for the rest
		// of the visit/session — the API re-verifies the hash on every request
		// regardless, this cookie is purely "don't make me paste it on every page".
		cookie.set(PREVIEW_TOKEN_COOKIE, queryToken, { path: '/', maxAge: 60 * 60 * 24 * 30, sameSite: 'lax' });
	}
	const previewToken = queryToken ?? cookie.get(PREVIEW_TOKEN_COOKIE)?.value;
	// ADR-0001: a preview request is `dynamic`. The remembered cookie unlocks an unpublished store just like the query
	// parameter, so its render must never be shared either (I-2).
	if (previewToken && !queryToken) vetoEdgeCache(headers, 'preview');
	try {
		const identity = await srShopIdentity(previewToken);
		return { identity: normalizeIdentity(identity), notPublished: false };
	} catch (e) {
		if (srErrorStatus(e) === 404) {
			status(404);
			return { identity: identityFromStaticTheme(), notPublished: true };
		}
		// API unreachable (offline dev, demo wrapper not up yet, transient error)
		// — fail OPEN to the static theme rather than showing "coming soon" for
		// an outage that has nothing to do with publish state. V39 / N10: that
		// degraded page is never edge-cached (the publish gate is unknown).
		vetoEdgeCache(headers, 'identity-fallback');
		return { identity: identityFromStaticTheme(), notPublished: false };
	}
}, {
	// Qwik Router 2.0.0-rc: loaders are strict by default and see no search
	// params unless allow-listed, so the preview token must be declared.
	search: ['preview_token'],
	// The shell reads this loader in the browser as well. With the router's default ('never')
	// each read after load re-fetched it from the server, re-running it and its API call on every page (#362). The value
	// is small and already rendered into the page. The maintenance loader keeps the default on purpose: passing options
	// makes a loader skip query-only navigations, and maintenance must be re-read on every navigation.
	serializationStrategy: 'always',
});

// onRequest (not onGet): the policy must cover actions (POST) as well as documents and loader data (GET).
export const onRequest: RequestHandler = async ({ url, headers, sharedMap }) => {
	// Loader/action data requests arrive with the page pathname (router trims q-loader-*.json): they must not
	// inherit a page profile. Every profile is private no-store; no cacheControl() call, no CDN header.
	const profile = resolveRouteCacheProfile(url.pathname, sharedMap);
	headers.set('x-route-class', profile.routeClass);
	headers.set('x-cache-policy-version', CACHE_POLICY_VERSION);
	headers.set('Cache-Control', profile.responseCacheControl);
};

/**
 * WS-E: polled on every request. Deliberately a plain routeLoader$ (not
 * cached/debounced — see docs/plans/2026-09-27-one-click-install.md decision
 * 1.11 and the stock-architecture "no cache" precedent this project follows
 * for anything that gates whether a page is even servable) so a maintenance
 * window that ends mid-visit clears on the visitor's very next navigation.
 */
export const useMaintenanceLoader = routeLoader$(async ({ headers }): Promise<SrMaintenanceStatus> => {
	// V39 / N10: rendering still fails OPEN on an unreachable API (an outage must not masquerade as maintenance), but a response
	// whose gate state is unknown, or that shows the maintenance screen, is never edge-cached.
	try {
		const { data } = await sellright().GET('/v1/maintenance', {});
		const status = data as SrMaintenanceStatus;
		if (status.maintenance !== false) vetoEdgeCache(headers, 'maintenance');
		return status;
	} catch {
		vetoEdgeCache(headers, 'maintenance-unknown');
		return { maintenance: false };
	}
});

/*
 * ADR-0001 §1 (I-2): nothing per visitor renders into the page. The signed-in customer, the `sr_legacy_cart` hint and the
 * credential adoption that the old root auth loader did on every SSR now come from GET /api/session/ (no-store) in
 * the browser (see ~/utils/session-customer.ts); the `countryCode` cookie is read in the browser below.
 */


// Component to render the global login modal
const LoginModalComponent = component$(() => {
	const loginModalState = useLoginModalState();
	const { closeLoginModal } = useLoginModalActions();

	return (
		<LoginModal
			isOpen={loginModalState.isOpen}
			onClose$={closeLoginModal}
			onLoginSuccess$={loginModalState.onLoginSuccess}
		/>
	);
});

// #360: nothing of the modal (auth, signup flow, providers) is rendered or loaded until an opener sets `everOpened`.
export const LoginModalGate = component$(() => {
	const loginModalState = useLoginModalState();
	return loginModalState.everOpened ? <LoginModalComponent /> : null;
});

export default component$(() => {
	const location = useLocation();
	const isHomePage = location.url.pathname === '/';
	// /affiliate is a single-purpose dashboard surface — render its own minimal
	// chrome via routes/affiliate/layout.tsx instead of the global Header + Footer.
	const isAffiliateSurface = location.url.pathname.startsWith('/affiliate');

	const imageTransformer$ = $(({ src, width, height }: ImageTransformerProps): string => {
		return `${src}?w=${width}&h=${height}&format=avif`;
	});

	useImageProvider({
		imageTransformer$,
		resolutions: IMAGE_RESOLUTIONS,
	});

	const identityData = useStoreIdentityLoader();
	const maintenanceData = useMaintenanceLoader();

	const state = useStore<AppState>({
		showCart: false,
		showMenu: false,
		showUserMenu: false,
		showMobileUserMenu: false,
		isLoading: false,
		// Signed out until the browser's session read says otherwise (ADR-0001 I-2: no identity in the HTML).
		customer: anonymousCustomer() as ActiveCustomer,
		availableCountries: [],
		shippingAddress: {
			id: '',
			city: '',
			company: '',
			countryCode: '',
			fullName: '',
			phoneNumber: '',
			postalCode: '',
			province: '',
			streetLine1: '',
			streetLine2: '',
		},
		billingAddress: {
			firstName: '',
			lastName: '',
			streetLine1: '',
			streetLine2: '',
			city: '',
			province: '',
			postalCode: '',
			countryCode: ''
		},
		addressBook: [],
	});

	useContextProvider(APP_STATE, state);

	// The signed-in customer, read in the browser (ADR-0001 I-2): once when the document starts, and again on each client
	// navigation to a new path, where the old root loader re-ran (e.g. /sign-in navigating on). Components read "signed in"
	// from appState.customer instead of asking /auth/me again (#362). Fields the account area adds (phone) stay while it is
	// the same customer. A failed read changes nothing. No identity is kept beyond the page.
	const session = useStore({ gen: 0 });
	const readSession = $(async () => {
		const gen = ++session.gen;
		const hadLegacyHint = LEGACY_HINT.test(document.cookie);
		const result = await fetchSessionCustomer();
		if (gen !== session.gen) return;
		const next = nextCustomer(state.customer, result);
		if (next) state.customer = next as ActiveCustomer;
		// The legacy-transport hint used to arrive with the page, before the cart booted. It now arrives with this read, so
		// when it is new, boot the cart again once the current boot settles: the second boot sees the hint and runs the
		// one-time legacy claim (a live read, like every boot).
		if (!hadLegacyHint && LEGACY_HINT.test(document.cookie)) {
			CartService.bootstrap().catch(() => undefined).then(() => CartService.bootstrap()).catch((e) => {
				console.error('Layout: legacy cart claim failed:', e);
			});
		}
	});
	useTask$(({ track }) => {
		track(() => location.url.pathname);
		if (!isBrowser) return;
		readSession();
	});

	// #360: the non-urgent start-up work, in one idle handler (it was three qinit/qidle handlers) so first paint and the first
	// interaction are not behind it. Header user state, the country default and cross-tab address sync appear a moment later.
	// Order matters: the cookie is the initial country, the stored preference below it wins. Stock reads are NOT here.
	useOnDocument('qidle', $(() => {
		// F1: header blur and scroll-timeline effects switch on only after load + first paint (html.sr-fx).
		enablePostPaintEffects();
		LocalAddressService.setupCrossTabSync();
		// countryCode cookie (ADR-0001 I-2: read here, not in SSR). Initial value only; the stored preference below wins.
		const cookieCountry = getCookie(COUNTRY_COOKIE);
		if (cookieCountry && !state.shippingAddress.countryCode) state.shippingAddress.countryCode = cookieCountry;
		readSession();
		const storedCountry = CountryPreferenceService.getCountry();
		// A saved or entered address keeps its own country (the checkout may have loaded one before this idle task).
		if (storedCountry && canRestorePreferredCountry(state.shippingAddress)) {
			state.shippingAddress.countryCode = storedCountry;
		}
	}));

	// T6: Scroll lock via CSS class — useTask$ tracks signals, toggles html.scroll-locked
	useTask$(({ track }) => {
		const isOpen = track(() => state.showCart || state.showMenu);
		if (!isBrowser) return;
		if (isOpen) {
			const scrollY = window.scrollY;
			document.body.dataset.scrollY = String(scrollY);
			document.body.style.top = `-${scrollY}px`;
			document.documentElement.classList.add('scroll-locked');
		} else {
			const scrollY = parseInt(document.body.dataset.scrollY || '0', 10);
			document.documentElement.classList.remove('scroll-locked');
			document.body.style.top = '';
			if (scrollY) window.scrollTo(0, scrollY);
		}
	});



	useOn(
		'keydown',
		$((event: unknown) => {
			if ((event as KeyboardEvent).key === 'Escape') {
				state.showCart = false;
				state.showMenu = false;
			}
		})
	);

	useOn('qwik-router-error', $((event: any) => {
		console.error('Qwik Router Error:', event.detail);
	}));

	// Maintenance takes priority over the publish gate: a store mid-update is a
	// temporary outage regardless of whether it's published yet.
	if (maintenanceData.value.maintenance) {
		return <MaintenanceScreen storeName={identityData.value.identity.storeName} />;
	}

	if (identityData.value.notPublished) {
		return <ComingSoon storeName={identityData.value.identity.storeName} />;
	}

	return (
		<CartProvider>
		<LoginModalProvider>
			<div>
				{!isAffiliateSurface && (hasView('shell.header') ? <BrandHeaderMount /> : <Header />)}
				{state.showCart && <ConditionalCart isHomePage={isHomePage} showCart={state.showCart} />}
				{!isAffiliateSurface && state.showMenu && <Menu />}
				<div style={{ position: 'relative', minHeight: '100vh', backgroundColor: 'var(--color-parchment)' }}>
					<main id="main-content" class={`flex-1 bg-[var(--color-page)] ${isHomePage || isAffiliateSurface ? '' : 'pt-[var(--header-offset)]'}`}>
						<Slot />
					</main>
					{!isAffiliateSurface && (hasView('shell.footer') ? <BrandFooterMount /> : <Footer />)}
					{HAS_ANALYTICS && <AnalyticsMount />}
				</div>
				{/* Global Login Modal */}
				<LoginModalGate />
			</div>
		</LoginModalProvider>
		</CartProvider>
	);
});
