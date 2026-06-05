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
import { APP_STATE, CUSTOMER_NOT_DEFINED_ID, IMAGE_RESOLUTIONS, AUTH_TOKEN, COUNTRY_COOKIE } from '~/constants';
import { Order } from '~/generated/graphql-shop';
import { ActiveCustomer, AppState } from '~/types';
import ConditionalCart from '../components/cart/ConditionalCart';
import Header from '../components/header/header';
import Footer from '../components/footer/footer';
import { CartProvider } from '~/contexts/CartContext';
import { LoginModalProvider, useLoginModalState, useLoginModalActions } from '~/contexts/LoginModalContext';
import LoginModal from '~/components/auth/LoginModal';
import { LocalAddressService } from '~/services/LocalAddressService';
import { LocalCartService } from '~/services/LocalCartService';
import { CACHE_POLICY_VERSION, getRouteCacheProfile } from '~/config/route-cache-policy';
import { DEV_API } from '~/constants';

export const onGet: RequestHandler = async ({ cacheControl, url, headers }) => {
	const pathname = url.pathname;
	const profile = getRouteCacheProfile(pathname);
	cacheControl(profile.cacheControl);
	headers.set('x-route-class', profile.routeClass);
	headers.set('x-cache-policy-version', CACHE_POLICY_VERSION);

	if (profile.responseCacheControl) {
		headers.set('Cache-Control', profile.responseCacheControl);
	}
};

// Lightweight auth check only - NO backend calls
export const useAuthLoader = routeLoader$(({ cookie }) => {
	const authToken = cookie.get(AUTH_TOKEN)?.value;
	const countryCode = cookie.get(COUNTRY_COOKIE)?.value;
	return {
		isAuthenticated: !!authToken,
		countryCode,
	};
});


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

	const authData = useAuthLoader();

	const state = useStore<AppState>({
		showCart: false,
		showMenu: false,
		showUserMenu: false,
		showMobileUserMenu: false,
		isLoading: false,
		customer: { id: CUSTOMER_NOT_DEFINED_ID, firstName: '', lastName: '', emailAddress: '' } as ActiveCustomer,
		activeOrder: {} as Order,
		collections: [],
		availableCountries: [],
		shippingAddress: {
			id: '',
			city: '',
			company: '',
			countryCode: authData.value.countryCode || '',
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

	// Initialize cross-tab storage listener (T4: idle, no UVT needed)
	useOnDocument('qidle', $(() => {
		LocalAddressService.setupCrossTabSync();
	}));

	// Cache invalidation: SSE with polling fallback (SSE fails over Cloudflare HTTP/2)
	// Deferred until after window load + idle — must stay off the LCP critical path
	useOnDocument('qidle', $(() => {
		const startCacheSync = () => {
		const baseUrl = import.meta.env.DEV ? DEV_API : window.location.origin;

		const clearCaches = () => {
			import('~/services/ProductCacheService').then(({ productCache }) => productCache.clear());
			import('~/services/query-deduplication').then(({ queryDeduplication }) => queryDeduplication.clear());
			import('~/services/shop-cache').then(({ ShopCache }) => ShopCache.clearAll());
		};

		let useFallbackPolling = false;
		let lastPollVersion = '';

		// Fallback: poll /api/cache-version every 60s
		const startPolling = () => {
			if (useFallbackPolling) return;
			useFallbackPolling = true;
			const poll = () => {
				fetch(`${baseUrl}/api/cache-version`).then(r => r.ok ? r.text() : '').then(v => {
					if (lastPollVersion && v && v !== lastPollVersion) clearCaches();
					if (v) lastPollVersion = v;
				}).catch(() => {});
			};
			poll();
			setInterval(poll, 60_000);
		};

		// Try SSE first
		try {
			const es = new EventSource(`${baseUrl}/api/cache-events`);
			let connected = false;
			es.onopen = () => { connected = true; };
			es.onmessage = (event) => {
				try {
					const data = JSON.parse(event.data);
					if (data.type === 'product-updated' || data.type === 'stock-changed') clearCaches();
				} catch (_) { /* ignore */ }
			};
			es.onerror = () => {
				es.close();
				if (!connected) startPolling();
			};
		} catch (_) {
			startPolling();
		}
		};

		// Defer past LCP: wait for window load, then requestIdleCallback (2s timeout fallback)
		const schedule = () => {
			if ('requestIdleCallback' in window) {
				(window as any).requestIdleCallback(startCacheSync, { timeout: 2000 });
			} else {
				setTimeout(startCacheSync, 1500);
			}
		};
		if (document.readyState === 'complete') {
			schedule();
		} else {
			window.addEventListener('load', schedule, { once: true });
		}
	}));

	useContextProvider(APP_STATE, state);

	// T3: Restore persisted country selection (qidle — lazy, no urgency)
	useOnDocument('qidle', $(() => {
		const storedCountry = LocalCartService.getCountry();
		if (storedCountry) {
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

	return (
		<CartProvider>
		<LoginModalProvider>
			<div>
				{!isAffiliateSurface && <Header />}
				{state.showCart && <ConditionalCart isHomePage={isHomePage} showCart={state.showCart} />}
				{!isAffiliateSurface && <Menu />}
				<div style={{ position: 'relative', minHeight: '100vh', backgroundColor: '#F7F2EA' }}>
					<main id="main-content" class={`flex-1 bg-[#F7F2EA] ${isHomePage || isAffiliateSurface ? '' : 'pt-16'}`}>
						<Slot />
					</main>
					{!isAffiliateSurface && <Footer />}
				</div>
				{/* Global Login Modal */}
				<LoginModalComponent />
			</div>
		</LoginModalProvider>
		</CartProvider>
	);
});