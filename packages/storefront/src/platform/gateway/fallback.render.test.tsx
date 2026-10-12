// Gateway plan §7 "Default output": with no brand views, every handle renders exactly what L1 rendered before the gateway, compared
// the way the e2e fallback proof compares pages (scripts/ssr-normalize.mjs: every element, attribute and text; Qwik bookkeeping only
// normalised). The "before" side is the raw component with today's call-site props and children.
import { $, type JSXOutput } from '@qwik.dev/core';
import { QwikRouterMockProvider } from '@qwik.dev/router';
import { ssrRenderToDom } from '@qwik.dev/core/testing';
import { describe, expect, it } from 'vitest';
import { normalizeHtml } from '../../../scripts/ssr-normalize.mjs';
import RawCheckIcon from '~/components/icons/CheckIcon';
import RawXMarkIcon from '~/components/icons/XMarkIcon';
import RawPencilIcon from '~/components/icons/PencilIcon';
import RawTrashIcon from '~/components/icons/TrashIcon';
import { Button as RawButton } from '~/components/buttons/Button';
import { HighlightedButton as RawHighlightedButton } from '~/components/buttons/HighlightedButton';
import RawAlert from '~/components/alert/Alert';
import RawSuccess from '~/components/success/Success';
import { ErrorMessage as RawErrorMessage } from '~/components/error-message/ErrorMessage';
import { OrderProcessingModal as RawOrderProcessingModal } from '~/components/OrderProcessingModal';
import RawComingSoon from '~/components/coming-soon/ComingSoon';
import RawMaintenanceScreen from '~/components/maintenance/MaintenanceScreen';
import { QuantityDropdown as RawQuantityDropdown } from '~/components/ui/QuantityDropdown';
import RawProductCard from '~/components/products/ProductCard';
import RawPrice from '~/components/products/Price';
import { HomeHero as RawHomeHero } from '~/components/home/HomeHero';
import { HomeServiceSection as RawHomeServiceSection, HomeTrustBar as RawHomeTrustBar } from '~/components/home/HomeSocialSections';
import { HomeTeeSection as RawHomeTeeSection } from '~/components/home/HomeTeeSection';
import RawShopFilters from '~/components/Filters';
import RawSearchFilters from '~/components/facet-filter-controls/Filters';
import RawFiltersButton from '~/components/filters-button/FiltersButton';
import { LoyaltyRedeem } from '~/components/loyalty/LoyaltyRedeem';
import { STYLES } from '~/components/home/homepage-styles';
import DefaultLegalCopy from '~/brand-slots/legal.copy';
import DefaultPaymentBadges from '~/brand-slots/payment.badges';
import DefaultPaymentWidget from '~/brand-slots/pdp.payment-widget';
import { getSlot } from '~/components/slots';
import * as G from './index';
import { platformAction } from './actions';

const html = async (jsx: JSXOutput) => {
	const { document } = await ssrRenderToDom(<QwikRouterMockProvider>{jsx}</QwikRouterMockProvider>, {});
	// normalizeHtml keeps a <QFUNCS> marker where Qwik emitted its derived-prop function table (bookkeeping, not rendered output); an
	// inline handle reads props through Qwik's derived functions where a literal prop did not, so only the marker's presence differs.
	// The per-render container id also appears without a preceding event list on an event-free page.
	return normalizeHtml(document.body.innerHTML).replace('<QFUNCS>', '').replace(/push\(0,"[a-z0-9]{6}"\)/g, 'push(0,"I")');
};

const policies = { shipping: { label: 'Ships fast', sub: '2-4 days' }, returns: { label: 'Returns', sub: '30 days' }, payment: { label: 'Pay', sub: 'Cards' } };
const facets = [{ id: 'f1', name: 'Colour', open: true, values: [{ id: 'v1', name: 'Red', selected: true }, { id: 'v2', name: 'Blue', selected: false }] }];
const press = () => platformAction('ui.press', $(() => undefined));

const PAIRS: [string, () => JSXOutput, () => JSXOutput][] = [
	['CheckIcon', () => <G.CheckIcon />, () => <RawCheckIcon />],
	['XMarkIcon forcedClass', () => <G.XMarkIcon forcedClass="w-4 h-4" />, () => <RawXMarkIcon forcedClass="w-4 h-4" />],
	['TrashIcon', () => <G.TrashIcon forcedClass="h-3.5 w-3.5" />, () => <RawTrashIcon forcedClass="h-3.5 w-3.5" />],
	[
		'HighlightedButton (account save)',
		() => <G.HighlightedButton onClick$={press()} icon="check" text=" &nbsp; Save Changes" />,
		() => (
			<RawHighlightedButton onClick$={$(() => undefined)}>
				<RawCheckIcon /> &nbsp; Save Changes
			</RawHighlightedButton>
		),
	],
	[
		'Button (icon class, cancel)',
		() => <G.Button onClick$={press()} icon="x-mark" iconClass="w-4 h-4" text=" &nbsp; Cancel" />,
		() => (
			<RawButton onClick$={$(() => undefined)}>
				<RawXMarkIcon forcedClass="w-4 h-4" /> &nbsp; Cancel
			</RawButton>
		),
	],
	[
		'HighlightedButton disabled (password)',
		() => <G.HighlightedButton onClick$={press()} disabled={true} icon="check" text=" &nbsp; Update Password" />,
		() => (
			<RawHighlightedButton onClick$={$(() => undefined)} disabled={true}>
				<RawCheckIcon /> &nbsp; Update Password
			</RawHighlightedButton>
		),
	],
	[
		'Button (modal cancel, plain space)',
		() => <G.Button onClick$={press()} icon="x-mark" text=" Cancel" />,
		() => (
			<RawButton onClick$={$(() => undefined)}>
				<RawXMarkIcon /> Cancel
			</RawButton>
		),
	],
	[
		'HighlightedButton (address edit)',
		() => <G.HighlightedButton onClick$={press()} icon="pencil" text=" &nbsp; Edit" />,
		() => (
			<RawHighlightedButton onClick$={$(() => undefined)}>
				<RawPencilIcon /> &nbsp; Edit
			</RawHighlightedButton>
		),
	],
	['Alert', () => <G.Alert message="Coupon expired" />, () => <RawAlert message="Coupon expired" />],
	['Success', () => <G.Success message="Saved" />, () => <RawSuccess message="Saved" />],
	['ErrorMessage', () => <G.ErrorMessage heading="Oops" message="Try again" />, () => <RawErrorMessage heading="Oops" message="Try again" />],
	['OrderProcessingModal visible', () => <G.OrderProcessingModal visible={true} storeName="Store" onClose$={press()} />, () => <RawOrderProcessingModal visible={true} storeName="Store" onClose$={$(() => undefined)} />],
	['OrderProcessingModal hidden', () => <G.OrderProcessingModal visible={false} storeName="Store" />, () => <RawOrderProcessingModal visible={false} storeName="Store" />],
	['ComingSoon', () => <G.ComingSoon storeName="Store" />, () => <RawComingSoon storeName="Store" />],
	['MaintenanceScreen', () => <G.MaintenanceScreen storeName="Store" />, () => <RawMaintenanceScreen storeName="Store" />],
	[
		'QuantityDropdown',
		() => <G.QuantityDropdown id="quantity-SKU1" value={2} options={[1, 2, 3, 4, 5, 6, 7, 8, 9, '10+']} theme="light" disabled={false} onChange$={platformAction('cart.quantity-select', $(() => undefined))} />,
		() => <RawQuantityDropdown id="quantity-SKU1" value={2} options={[1, 2, 3, 4, 5, 6, 7, 8, 9, '10+']} theme="light" disabled={false} onChange$={$(() => undefined)} />,
	],
	[
		'ProductCard (shop)',
		() => <G.ProductCard key="tee" image="/img/tee.jpg" name="Tee" slug="tee" price={2500} inStock={false} priority={true} salePrice={null} preOrderPrice={null} isPreOrder={false} />,
		() => <RawProductCard key="tee" image="/img/tee.jpg" name="Tee" slug="tee" price={2500} inStock={false} priority={true} salePrice={null} preOrderPrice={null} isPreOrder={false} />,
	],
	['ProductCard skeleton', () => <G.ProductCard skeleton slug="" />, () => <RawProductCard skeleton slug="" />],
	[
		'ProductCard written with an empty close tag (search page)',
		() => <G.ProductCard key="tee" image={null} name="Tee" slug="tee" price={null} inStock={true}></G.ProductCard>,
		() => <RawProductCard key="tee" image={null} name="Tee" slug="tee" price={null} inStock={true}></RawProductCard>,
	],
	['Price', () => <G.Price price={2500} salePrice={1999} forcedClass="po-price" />, () => <RawPrice price={2500} salePrice={1999} forcedClass="po-price" />],
	['HomeHero', () => <G.HomeHero storeName="Store" tagline="Tag" policies={{ shipping: policies.shipping, returns: policies.returns }} />, () => <RawHomeHero storeName="Store" tagline="Tag" policies={{ shipping: policies.shipping, returns: policies.returns }} />],
	['HomeTrustBar', () => <G.HomeTrustBar policies={policies} />, () => <RawHomeTrustBar policies={policies} />],
	['HomeServiceSection', () => <G.HomeServiceSection />, () => <RawHomeServiceSection />],
	['HomeTeeSection empty', () => <G.HomeTeeSection product={null} variant={null} />, () => <RawHomeTeeSection product={null} variant={null} />],
	[
		'HomeTeeSection product',
		() => <G.HomeTeeSection product={{ name: 'Tee', slug: 'tee', category: 'Shirts', description: 'Soft', featuredAsset: { preview: '/a.jpg' } }} variant={{ price: 2000, priceWithTax: 2400, customFields: { salePrice: null, preOrderPrice: null, isPreOrder: false } }} />,
		() => <RawHomeTeeSection product={{ name: 'Tee', slug: 'tee', category: 'Shirts', description: 'Soft', featuredAsset: { preview: '/a.jpg' } }} variant={{ price: 2000, priceWithTax: 2400, customFields: { salePrice: null, preOrderPrice: null, isPreOrder: false } }} />,
	],
	[
		'ShopFilters',
		() => <G.ShopFilters facetsWithValues={facets} facetValueIds={['v1']} searchTerm="red" onFilterChange$={platformAction('filters.value', $(() => undefined))} onSearchChange$={platformAction('filters.search', $(() => undefined))} />,
		() => <RawShopFilters facetsWithValues={facets} facetValueIds={['v1']} searchTerm="red" onFilterChange$={$(() => undefined)} onSearchChange$={$(() => undefined)} />,
	],
	[
		'SearchFilters',
		() => <G.SearchFilters showMenu={true} facetsWithValues={facets} onToggleMenu$={press()} onFilterChange$={platformAction('filters.value', $(() => undefined))} onOpenCloseFilter$={platformAction('filters.value', $(() => undefined))} />,
		() => <RawSearchFilters showMenu={true} facetsWithValues={facets} onToggleMenu$={$(() => undefined)} onFilterChange$={$(() => undefined)} onOpenCloseFilter$={$(() => undefined)} />,
	],
	['FiltersButton', () => <G.FiltersButton onToggleMenu$={press()} />, () => <RawFiltersButton onToggleMenu$={$(() => undefined)} />],
	[
		'LoyaltyRedemptionView with no brand slot = the base LoyaltyRedeem',
		() => <G.LoyaltyRedemptionView balance={500} minRedeemPoints={100} offer={{ points: 500, discountCents: 500 }} applied={null} discountableCents={4000} currencyCode="USD" onRedeemToggle$={platformAction('loyalty.redeem-toggle', $(() => ({ ok: true as const })))} />,
		() => <LoyaltyRedeem balance={500} minRedeemPoints={100} offer={{ points: 500, discountCents: 500 }} applied={null} discountableCents={4000} currencyCode="USD" onRedeemToggle$={$(async () => ({ ok: true as const }))} />,
	],
];

describe('gateway default output: each handle renders what L1 rendered before', () => {
	for (const [name, gateway, before] of PAIRS) {
		it(name, async () => {
			const after = await html(gateway());
			expect(after).toBe(await html(before()));
			expect(after.length).toBeGreaterThan(0);
		});
	}

	// The render config registers the slots the product ships (src/brand-slots), so these compare the default implementations.
	it('slot handles render the shipped default implementation, validated, with output equal to the component alone', async () => {
		const badges = await html(<G.PaymentBadgesView placement="footer" />);
		expect(badges).toBe(await html(<DefaultPaymentBadges placement="footer" />));
		expect(badges).toContain('Sezzle');
		const widget = await html(<G.PaymentWidgetView priceCents={4000} />);
		expect(widget).toBe(await html(<DefaultPaymentWidget priceCents={4000} />));
		expect(widget).toContain('4 interest-free payments of');
		const legal = await html(<G.LegalCopyView section="privacy.payment-processors" />);
		expect(legal).toBe(await html(<DefaultLegalCopy section="privacy.payment-processors" />));
		expect(legal).toContain('NMI, Sezzle');
	});

	it('the default slots are really registered (an empty registry would make the comparison above vacuous)', () => {
		for (const name of ['payment.badges', 'pdp.payment-widget', 'legal.copy'] as const) expect(getSlot(name), name).toBeDefined();
	});

	it('slot handles with no brand slot and no fallback render nothing', async () => {
		const identity = { storeName: 'S', legalName: 'S', tagline: '', supportEmail: '', logoText: 'S', logoImageUrl: null, siteOrigin: '', social: {} };
		const views: JSXOutput[] = [
			<G.FreeShippingProgressView key="v1" currencyCode="USD" subtotalCents={1000} lineCount={1} isCheckoutView={false} countryCode={null} discountedSubtotalCents={1000} />,
			<G.GuaranteeModalView key="v4" productId="1" productName="Tee" />,
			<G.WaitlistView key="v5" productId="1" productName="Tee" soldOut={true} />,
			<G.SustainabilityBadgeView key="v6" orderCount={2} statsLoaded={true} />,
			<G.ShellFooterView key="v8" identity={identity} paymentLabels={['Card']} year={2026} />,
			<G.ContentView key="v9" identity={identity} pageKey="about" pathname="/about/" />,
		];
		for (const v of views) expect(await html(<div id="host">{v}</div>)).toBe(await html(<div id="host" />));
	});

	it('homepage styles reach the page unchanged', () => {
		expect(G.homepageStyles).toBe(STYLES);
	});
});
