import { component$, useContext, useOnDocument, useOnWindow, $, useSignal, useStyles$ } from '@qwik.dev/core';
import { LocalCartService } from '~/services/LocalCartService';
import { useLocalCart, refreshCartStock, loadCartIfNeeded } from '~/contexts/CartContext';
import { useLocation, Link, useNavigate } from '@qwik.dev/router';
import { APP_STATE, CUSTOMER_NOT_DEFINED_ID } from '~/constants';
import { logoutMutation } from '~/providers/shop/customer/customer';
import { isCheckoutPage } from '~/utils/route-helpers';
import LogoImage from '~/media/logo.svg?jsx';
import { useLoginModalActions } from '~/contexts/LoginModalContext';


const HEADER_STYLES = `
  .header-nav-link {
    font-family: var(--font-body);
    font-weight: 500;
    font-size: var(--step--1);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: #9A9488;
    min-height: 44px;
    display: flex;
    align-items: center;
    transition: color 0.3s ease;
    cursor: pointer;
    text-decoration: none;
  }
  .header-nav-link:hover {
    color: #B06B56;
  }
  .header-nav-link.active {
    color: #B06B56;
  }
  .header-icon {
    color: #9A9488;
    transition: color 0.3s ease;
    cursor: pointer;
  }
  .header-icon:hover {
    color: #B06B56;
  }
  .header-badge {
    position: absolute;
    top: 6px;
    right: 2px;
    width: 16px;
    height: 16px;
    background: #965341;
    color: #fff;
    font-size: 0.625rem;
    font-weight: 700;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
  }
  .header-icon-btn {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 10px;
    min-width: 44px;
    min-height: 44px;
  }
  .header-scrolled {
    background: rgba(10, 10, 10, 0.8);
    backdrop-filter: blur(20px) saturate(1.2);
    -webkit-backdrop-filter: blur(20px) saturate(1.2);
    box-shadow: 0 1px 0 rgba(255, 255, 255, 0.05);
  }

  /* CSS scroll-driven header solidify — zero-latency on compositor thread */
  @keyframes dd-header-solidify {
    from {
      background: transparent;
      backdrop-filter: blur(0) saturate(1);
      -webkit-backdrop-filter: blur(0) saturate(1);
      box-shadow: none;
    }
    to {
      background: rgba(10, 10, 10, 0.8);
      backdrop-filter: blur(20px) saturate(1.2);
      -webkit-backdrop-filter: blur(20px) saturate(1.2);
      box-shadow: 0 1px 0 rgba(255, 255, 255, 0.05);
    }
  }

  .header-home-transparent {
    background: transparent;
    animation: dd-header-solidify linear both;
    animation-timeline: scroll();
    animation-range: 0px 101px;
  }

  /* Fallback for browsers without scroll-driven animations */
  @supports not (animation-timeline: scroll()) {
    .header-home-transparent {
      animation: none;
    }
  }
  .header-user-dropdown {
    background: #1A1A1A;
    border: 1px solid #2A2A28;
  }
  .header-user-dropdown a,
  .header-user-dropdown button {
    font-family: var(--font-body);
    font-weight: 500;
    font-size: var(--step--1);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: #9A9488;
    transition: color 0.2s ease, background-color 0.2s ease;
  }
  .header-user-dropdown a:hover,
  .header-user-dropdown button:hover {
    color: #B06B56;
    background-color: rgba(255, 255, 255, 0.04);
  }
  .mobile-overlay {
    background: rgba(10, 10, 10, 0.95);
    backdrop-filter: blur(24px) saturate(1.2);
    -webkit-backdrop-filter: blur(24px) saturate(1.2);
  }
  .mobile-nav-link {
    font-family: var(--font-body);
    font-weight: 500;
    font-size: 1.25rem;
    letter-spacing: 2px;
    text-transform: uppercase;
    color: #9A9488;
    min-height: 56px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: color 0.2s ease, background-color 0.2s ease;
    border-radius: 8px;
    padding: 16px 24px;
    text-decoration: none;
  }
  .mobile-nav-link:hover,
  .mobile-nav-link.active {
    color: #B06B56;
    background-color: rgba(255, 255, 255, 0.04);
  }
  .mobile-sub-link {
    font-family: var(--font-body);
    font-weight: 500;
    font-size: 1rem;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    color: #9A9488;
    display: block;
    padding: 12px 24px;
    transition: color 0.2s ease, background-color 0.2s ease;
    border-radius: 8px;
    text-decoration: none;
  }
  .mobile-sub-link:hover {
    color: #B06B56;
    background-color: rgba(255, 255, 255, 0.04);
  }
  .burger-btn {
    display: flex;
  }
  @media (min-width: 768px) {
    .burger-btn {
      display: none;
    }
  }
`;

export default component$(() => {
	useStyles$(HEADER_STYLES);
	const appState = useContext(APP_STATE);
	const location = useLocation();
	const isScrolledFallback = useSignal(false);
	const { openLoginModal } = useLoginModalActions();
	const nav = useNavigate();
	const userMenuRef = useSignal<Element>();

	const localCart = useLocalCart();
	const cartQuantitySignal = useSignal(0);

	// T2: init cart count from storage on boot
	useOnDocument('qinit', $(() => {
		cartQuantitySignal.value = LocalCartService.getCartQuantityFromStorage();
	}));

	// T2: live cart count updates
	useOnWindow('cart-updated', $((event: Event) => {
		cartQuantitySignal.value = (event as CustomEvent).detail.totalQuantity;
	}));

	const totalQuantity = cartQuantitySignal.value || appState.activeOrder?.totalQuantity || 0;
	const isOnCheckoutPage = isCheckoutPage(location.url.toString());
	const isOnConfirmationPage = location.url.pathname.includes('/checkout/confirmation/');
	const isHomePage = location.url.pathname === '/';

	// T8: Fallback scroll for browsers without animation-timeline: scroll()
	useOnWindow('scroll', $(() => {
		if (CSS.supports('animation-timeline', 'scroll()')) return;
		isScrolledFallback.value = window.scrollY > 100;
	}));

	// T7: Centralized click-outside for user menu (data-user-menu attr on container)
	useOnWindow('click', $((event: Event) => {
		const t = event.target as HTMLElement;
		if (!t.closest('[data-user-menu]')) {
			appState.showUserMenu = false;
		}
	}));

	const logout = $(async () => {
		await logoutMutation();
		window.location.reload();
	});

	// CSS animation-timeline: scroll() handles transparent→solid on compositor (zero latency).
	// JS fallback only fires on browsers without support.
	const headerClass = !isHomePage
		? 'header-scrolled'
		: isScrolledFallback.value
			? 'header-scrolled'
			: 'header-home-transparent';

	return (
		<header
			class={`fixed top-0 left-0 right-0 z-50 transition-all duration-500 ease-in-out ${headerClass}`}
			style={{ height: '72px' }}
		>
			<div class="max-w-[1920px] mx-auto px-4 sm:px-6 lg:px-8 w-full h-full">
				<div class="relative flex items-center justify-between h-full">

					{/* LEFT: Logo only */}
					<div class="flex items-center flex-shrink-0">
						<Link href="/" aria-label="Damned Designs — Go to homepage">
							<LogoImage
								alt="Damned Designs"
								class="h-8 w-auto object-contain bg-transparent filter brightness-0 invert transition-opacity duration-300"
								width="100"
								height="32"
							/>
						</Link>
					</div>

					{/* CENTER: Nav links — absolutely centered */}
					<nav class="hidden md:flex absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 items-center gap-10">
						<Link
							href="/shop"
							prefetch
							class={`header-nav-link ${location.url.pathname.startsWith('/shop') ? 'active' : ''}`}
						>
							Shop
						</Link>
						<Link
							href="/about"
							class={`header-nav-link ${location.url.pathname.startsWith('/about') ? 'active' : ''}`}
						>
							About
						</Link>
						<Link
							href="/blog/"
							class={`header-nav-link ${location.url.pathname.startsWith('/blog') ? 'active' : ''}`}
						>
							Lore
						</Link>
						<Link
							href="/contact"
							class={`header-nav-link ${location.url.pathname.startsWith('/contact') ? 'active' : ''}`}
						>
							Contact
						</Link>
					</nav>

					{/* RIGHT: Cart + Account icons */}
					<div class="flex items-center gap-1 flex-shrink-0">

						{/* Cart icon */}
						{!(isOnCheckoutPage || isOnConfirmationPage) && (
							<div
								class="header-icon-btn cursor-pointer"
								role="button"
								tabIndex={0}
								onClick$={$(async () => {
									if (!appState.shippingAddress.countryCode) {
										appState.shippingAddress.countryCode = LocalCartService.getCountry();
									}
									if (appState.showCart) {
										appState.showCart = false;
									} else {
										loadCartIfNeeded(localCart);
										appState.showCart = true;
										if (localCart.localCart.items.length > 0) {
											refreshCartStock(localCart).then(() => {
												window.dispatchEvent(new CustomEvent('cart-updated', {
													detail: { totalQuantity: localCart.localCart.totalQuantity }
												}));
											}).catch(console.error);
										}
									}
									cartQuantitySignal.value = LocalCartService.getCartQuantityFromStorage();
								})}
								aria-label={`${totalQuantity} items in cart`}
								title="View cart"
							>
								<svg
									class="header-icon"
									width="22"
									height="22"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="1.5"
								>
									<path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/>
									<line x1="3" y1="6" x2="21" y2="6"/>
									<path d="M16 10a4 4 0 01-8 0"/>
								</svg>
								{totalQuantity > 0 && (
									<span class="header-badge">{totalQuantity}</span>
								)}
							</div>
						)}

						{/* Account icon — desktop only */}
						<div class="hidden md:flex header-icon-btn" ref={userMenuRef} data-user-menu>
							<svg
								onClick$={() => {
									if (appState.customer.id !== CUSTOMER_NOT_DEFINED_ID) {
										appState.showUserMenu = !appState.showUserMenu;
									} else {
										openLoginModal();
									}
								}}
								class="header-icon cursor-pointer"
								width="20"
								height="20"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="1.5"
								aria-label={appState.customer.id !== CUSTOMER_NOT_DEFINED_ID ? 'Account menu' : 'Sign in'}
							>
								<path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/>
								<circle cx="12" cy="7" r="4"/>
							</svg>

							{/* User dropdown */}
							{appState.showUserMenu && appState.customer.id !== CUSTOMER_NOT_DEFINED_ID && (
								<div
									class="header-user-dropdown absolute right-0 top-full mt-2 w-44 rounded-lg shadow-2xl z-10 overflow-hidden"
								>
									<div class="py-1">
										<button
											onClick$={() => { nav('/account'); appState.showUserMenu = false; }}
											class="block px-4 py-2.5 w-full text-left cursor-pointer"
										>
											Account
										</button>
										<button
											onClick$={logout}
											class="block w-full text-left px-4 py-2.5 cursor-pointer"
										>
											Logout
										</button>
									</div>
								</div>
							)}
						</div>

						{/* Mobile burger */}
						<button
							class="burger-btn header-icon-btn cursor-pointer"
							onClick$={() => (appState.showMenu = !appState.showMenu)}
							aria-label="Open menu"
						>
							<svg
								class="header-icon"
								width="24"
								height="24"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="1.5"
								stroke-linecap="round"
							>
								<line x1="4" y1="7" x2="20" y2="7"/>
								<line x1="4" y1="12" x2="20" y2="12"/>
								<line x1="4" y1="17" x2="20" y2="17"/>
							</svg>
						</button>
					</div>
				</div>
			</div>

			{/* Mobile full-screen overlay */}
			{appState.showMenu && (
				<div class="mobile-overlay fixed inset-0 z-50 w-full h-full flex flex-col items-center justify-center px-6"
					style={{ minHeight: '100vh' }}
				>
					<button
						class="absolute top-5 right-5 p-2 rounded-lg transition-colors duration-200"
						style={{ color: '#9A9488' }}
						onClick$={() => (appState.showMenu = false)}
						aria-label="Close menu"
					>
						<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="w-6 h-6"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
					</button>

					<nav class="flex flex-col gap-4 w-full max-w-sm">
						<Link
							href="/shop"
							class={`mobile-nav-link ${location.url.pathname.startsWith('/shop') ? 'active' : ''}`}
							onClick$={() => { setTimeout(() => { appState.showMenu = false; }, 0); }}
						>
							Shop
						</Link>
						<Link
							href="/about"
							class={`mobile-nav-link ${location.url.pathname.startsWith('/about') ? 'active' : ''}`}
							onClick$={() => { setTimeout(() => { appState.showMenu = false; }, 0); }}
						>
							About
						</Link>
						<Link
							href="/blog/"
							class={`mobile-nav-link ${location.url.pathname.startsWith('/blog') ? 'active' : ''}`}
							onClick$={() => { setTimeout(() => { appState.showMenu = false; }, 0); }}
						>
							Lore
						</Link>
						<Link
							href="/contact"
							class={`mobile-nav-link ${location.url.pathname.startsWith('/contact') ? 'active' : ''}`}
							onClick$={() => { setTimeout(() => { appState.showMenu = false; }, 0); }}
						>
							Contact
						</Link>

						<div class="w-16 h-px mx-auto my-2" style={{ background: '#2A2A28' }}></div>

						<button
							class={`mobile-nav-link w-full ${
								location.url.pathname.startsWith('/account') || location.url.pathname.startsWith('/sign-in')
									? 'active' : ''
							}`}
							onClick$={() => {
								if (appState.customer.id !== CUSTOMER_NOT_DEFINED_ID) {
									appState.showMobileUserMenu = !appState.showMobileUserMenu;
								} else {
									openLoginModal();
									appState.showMenu = false;
								}
							}}
						>
							{appState.customer.id !== CUSTOMER_NOT_DEFINED_ID ? 'Account' : 'Sign In'}
						</button>

						{appState.showMobileUserMenu && appState.customer.id !== CUSTOMER_NOT_DEFINED_ID && (
							<div class="w-full rounded-lg overflow-hidden" style={{ background: '#1A1A1A', border: '1px solid #2A2A28' }}>
								<button
									onClick$={() => {
										nav('/account');
										appState.showMobileUserMenu = false;
										appState.showMenu = false;
									}}
									class="mobile-sub-link w-full text-left cursor-pointer"
								>
									My Account
								</button>
								<button
									onClick$={logout}
									class="mobile-sub-link w-full text-left cursor-pointer"
								>
									Logout
								</button>
							</div>
						)}
					</nav>
				</div>
			)}
		</header>
	);
});
