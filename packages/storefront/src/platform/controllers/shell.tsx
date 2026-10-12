// Brand views, plan §2.3 `shell.header` / `shell.footer`: the L1 mounts. They read APP_STATE, the cart and the identity loader (a brand
// never does) and hand the brand view a detached projection plus `on*$` actions that go through the dispatcher.
import { $, component$, useComputed$, useContext, useStore, useVisibleTask$ } from '@qwik.dev/core';
import { useLocation, useNavigate } from '@qwik.dev/router';
import { APP_STATE, CUSTOMER_NOT_DEFINED_ID } from '~/constants';
import { useCart } from '~/contexts/CartContext';
import { useLoginModalActions } from '~/contexts/LoginModalContext';
import { logout as logoutAccount } from '~/providers/shop/account/account';
import { useStoreIdentityLoader } from '~/routes/layout';
import { isCheckoutPage } from '~/utils/route-helpers';
import { PROVIDER_LABELS } from '~/platform/payments/labels';
import { useCartToggle } from '~/platform/cart';
import { ACTION_RESULTS, dispatch, type ActionCtl } from './callbacks';
import { projectIdentity, seal } from './project';
import { shellFooterView, shellHeaderView } from './views';
import type { ActionResult, ShellFooterProps, ShellViewProps } from '~/platform/views';

type ShellData = Omit<ShellViewProps, 'onCartToggle$' | 'onLogin$' | 'onLogout$' | 'onAccount$'>;

/** The shell header view, fed by the platform. Only mounted when `route`'s caller found a `shell.header` slot. */
export const BrandHeaderMount = component$(() => {
	const View = shellHeaderView!;
	const appState = useContext(APP_STATE);
	const cart = useCart();
	const location = useLocation();
	const nav = useNavigate();
	const identity = useStoreIdentityLoader();
	const toggleCart = useCartToggle();
	const { openLoginModal } = useLoginModalActions();
	const ctl = useStore<ActionCtl>({ disposed: false, admitted: [] });
	useVisibleTask$(({ cleanup }) => cleanup(() => { ctl.disposed = true; }));

	const data = useComputed$(() =>
		seal<ShellData>({
			identity: projectIdentity(identity.value.identity) as ShellData['identity'],
			pathname: location.url.pathname,
			isHome: location.url.pathname === '/',
			isCheckout: isCheckoutPage(location.url.toString()),
			isConfirmation: location.url.pathname.includes('/checkout/confirmation/'),
			isNavigating: location.isNavigating,
			cartQuantity: cart.cart.lines.reduce((sum, line) => sum + line.quantity, 0),
			cartOpen: appState.showCart,
			account: { signedIn: appState.customer.id !== CUSTOMER_NOT_DEFINED_ID, displayName: appState.customer.id !== CUSTOMER_NOT_DEFINED_ID ? appState.customer.firstName || null : null },
		}),
	);

	// useCartToggle: opening the cart runs the live stock refresh (the locked stock rule), exactly as the base header does.
	const onCartToggle$ = $(() => dispatch<ActionResult>(ctl, null, ACTION_RESULTS, async () => { await toggleCart(); return { ok: true }; }));
	const onLogin$ = $(() => dispatch<ActionResult>(ctl, null, ACTION_RESULTS, () => { openLoginModal(); return { ok: true }; }));
	const onLogout$ = $(() =>
		dispatch<ActionResult>(ctl, null, ACTION_RESULTS, async () => {
			const result = await logoutAccount();
			if (!result.ok) return { ok: false, reason: 'error' };
			window.location.reload();
			return { ok: true };
		}),
	);
	const onAccount$ = $(() => dispatch<ActionResult>(ctl, null, ACTION_RESULTS, async () => {
		if (appState.customer.id === CUSTOMER_NOT_DEFINED_ID) return { ok: false, reason: 'invalid' };
		await nav('/account');
		appState.showUserMenu = false;
		return { ok: true };
	}));

	return <View {...data.value} onCartToggle$={onCartToggle$} onLogin$={onLogin$} onLogout$={onLogout$} onAccount$={onAccount$} />;
});

/** The shell footer view. */
export const BrandFooterMount = component$(() => {
	const View = shellFooterView!;
	const identity = useStoreIdentityLoader();
	const data = useComputed$(() =>
		seal<ShellFooterProps>({
			identity: projectIdentity(identity.value.identity) as ShellFooterProps['identity'],
			paymentLabels: Object.values(PROVIDER_LABELS),
			year: new Date().getFullYear(),
		}),
	);
	return <View {...data.value} />;
});
