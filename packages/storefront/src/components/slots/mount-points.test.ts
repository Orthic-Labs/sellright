// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SLOT_NAMES, type SlotName } from './registry';

// One test per mount point (plan A17; gateway plan §4). Components are not rendered here (gateway/*.render.test.tsx render them);
// this checks the contract each mount keeps: its slot is looked up by name in exactly one place, the gateway handle
// (`slotGate('<name>'` in platform/gateway/index.tsx), the mount file renders that handle, and it keeps its fallback / absent guard.
// Rendering is also covered by e2e/slots.spec.ts against compiled fixture slots.
const SRC = fileURLToPath(new URL('../..', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const GATEWAY = 'platform/gateway/index.tsx';

interface Mount {
	file: string;
	/** The gateway handle the mount file renders. */
	handle: string;
	/** Text the mount file must still contain: the fallback markup or the "absent renders nothing" guard. */
	keeps: RegExp;
}

const MOUNTS: Record<SlotName, Mount> = {
	'cart.free-shipping-progress': { file: 'components/cart-contents/CartContents.tsx', handle: 'FreeShippingProgressView', keeps: /<FreeShippingProgressView\n/ },
	'checkout.loyalty-redemption': { file: 'components/checkout/CheckoutOrderSummary.tsx', handle: 'LoyaltyRedemptionView', keeps: /<LoyaltyRedemptionView \{\.\.\.view\} onRedeemToggle\$=\{platformAction\('loyalty\.redeem-toggle', props\.onRedeemToggle\$\)\} \/>/ },
	'payment.badges': { file: 'components/footer/footer.tsx', handle: 'PaymentBadgesView', keeps: /\{hasPaymentBadges && <PaymentBadgesView placement="footer" \/>\}/ },
	'pdp.payment-widget': { file: 'routes/products/[...slug]/ProductPageView.tsx', handle: 'PaymentWidgetView', keeps: /\{hasPaymentWidget && <PaymentWidgetView priceCents=\{widgetPriceCents\} \/>\}/ },
	'pdp.guarantee-modal': { file: 'routes/products/[...slug]/ProductPageView.tsx', handle: 'GuaranteeModalView', keeps: /\{hasGuaranteeModal && <GuaranteeModalView / },
	'pdp.waitlist': { file: 'routes/products/[...slug]/ProductPageView.tsx', handle: 'WaitlistView', keeps: /const waitlistAvailable = hasWaitlist && [^\n]+;[\s\S]*\{waitlistAvailable && \(\s*<div id="sr-pdp-waitlist">\s*<WaitlistView / },
	'account.order-card': { file: 'routes/account/orders/index.tsx', handle: 'OrderCardView', keeps: /if \(hasOrderCard\) return <OrderCardView[^>]*\/>;\n\s*return \(\n\s*<a/ },
	'account.sustainability-badge': { file: 'routes/account/index.tsx', handle: 'SustainabilityBadgeView', keeps: /\{hasSustainabilityBadge && <SustainabilityBadgeView / },
	'legal.copy': { file: 'routes/privacy/index.tsx', handle: 'LegalCopyView', keeps: /\{hasLegalCopy \? <LegalCopyView section="privacy\.payment-processors" \/> : 'payment service providers'\}/ },
	// Brand views: the routes choose between the L1 Brand<X>Mount and today's component with `hasView('<name>')` (VIEW_CHOICES below);
	// the mount renders the slot's gateway handle.
	'shell.header': { file: 'platform/controllers/shell.tsx', handle: 'ShellHeaderView', keeps: /<ShellHeaderView\n/ },
	'shell.footer': { file: 'platform/controllers/shell.tsx', handle: 'ShellFooterView', keeps: /<ShellFooterView \{\.\.\.data\.value\} \/>/ },
	'route.home': { file: 'platform/controllers/content.tsx', handle: 'HomeView', keeps: /<HomeView\s+\{\.\.\.data\.value\}/ },
	'route.content': { file: 'platform/controllers/content.tsx', handle: 'ContentView', keeps: /<ContentView \{\.\.\.data\.value\} \/>/ },
	'route.blog': { file: 'platform/controllers/content.tsx', handle: 'BlogListView', keeps: /<BlogListView \{\.\.\.data\.value\} \/>/ },
	'route.blog-post': { file: 'platform/controllers/content.tsx', handle: 'BlogPostView', keeps: /<BlogPostView \{\.\.\.data\.value\} \/>/ },
	'route.contact': { file: 'platform/controllers/content.tsx', handle: 'ContactView', keeps: /<ContactView \{\.\.\.data\.value\}/ },
	'route.shop': { file: 'platform/controllers/shop.tsx', handle: 'ShopView', keeps: /<ShopView\n/ },
	// found and missing are two handles of one slot: the missing one has no actions and no controller behind it
	'route.product': { file: 'platform/controllers/product.tsx', handle: 'ProductView', keeps: /<ProductMissingView \{\.\.\.data\.value\} \/>/ },
};

/** Where each view picks the L1 mount over today's component, and that today's component stays the fallback branch. */
const VIEW_CHOICES: { file: string; choice: RegExp }[] = [
	{ file: 'routes/layout.tsx', choice: /\(hasView\('shell\.header'\) \? <BrandHeaderMount \/> : <Header \/>\)/ },
	{ file: 'routes/layout.tsx', choice: /\(hasView\('shell\.footer'\) \? <BrandFooterMount \/> : <Footer \/>\)/ },
	{ file: 'routes/index.tsx', choice: /export default hasView\('route\.home'\) \? BrandHomeMount : BaseHomePage;/ },
	{ file: 'routes/about/index.tsx', choice: /export default hasContentViewFor\('\/about\/'\) \? BrandContentMount : BaseAboutPage;/ },
	{ file: 'routes/privacy/index.tsx', choice: /export default hasContentViewFor\('\/privacy\/'\) \? BrandContentMount : BasePrivacyPage;/ },
	{ file: 'routes/terms/index.tsx', choice: /export default hasContentViewFor\('\/terms\/'\) \? BrandContentMount : BaseTermsPage;/ },
	{ file: 'routes/returns/index.tsx', choice: /export default hasContentViewFor\('\/returns\/'\) \? BrandContentMount : BaseReturnsPage;/ },
	{ file: 'routes/press/index.tsx', choice: /export default hasContentViewFor\('\/press\/'\) \? BrandContentMount : BasePressPage;/ },
	{ file: 'routes/contact/index.tsx', choice: /export default hasView\('route\.contact'\) \? BrandContactMount : BaseContactPage;/ },
	{ file: 'routes/blog/index.tsx', choice: /export default hasView\('route\.blog'\) \? BrandBlogMount : BaseBlogPage;/ },
	{ file: 'routes/blog/[slug]/index.tsx', choice: /export default hasView\('route\.blog-post'\) \? BrandBlogPostMount : BaseBlogPostPage;/ },
	{ file: 'routes/shop/index.tsx', choice: /export default hasView\('route\.shop'\) \? BrandShopMount : BaseShopPage;/ },
	{ file: 'routes/products/[...slug]/index.tsx', choice: /export default hasView\('route\.product'\) \? BrandProductMount : BaseProductPage;/ },
	{ file: 'routes/shop/[slug]/index.tsx', choice: /export default ACTIVE \? \(hasView\('route\.product'\) \? BrandProductMount : BaseProductPage\) : CatchAll;/ },
	{ file: 'routes/[...catchall]/index.tsx', choice: /if \(hasContentViewFor\(currentPath\) && matchDeclaredPath\(DECLARED_CONTENT, currentPath\)\) return <BrandContentMount reviewSummary=\{reviewSummary\.value\} \/>;/ },
];

function allSourceFiles(dir: string, out: string[] = []): string[] {
	for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, ent.name);
		if (ent.isDirectory()) allSourceFiles(p, out);
		else if (/\.(ts|tsx)$/.test(ent.name) && !/\.test\.tsx?$/.test(ent.name)) out.push(p);
	}
	return out;
}

describe('slot mount points', () => {
	it('every registry slot has a mount entry and every entry is a registry slot', () => {
		expect(Object.keys(MOUNTS).sort()).toEqual([...SLOT_NAMES].sort());
	});

	const sources = allSourceFiles(SRC)
		.filter((f) => !f.includes('__fixtures__') && !f.includes('__stubs__'))
		.map((f) => ({ f, rel: path.relative(SRC, f).split(path.sep).join('/'), text: fs.readFileSync(f, 'utf8') }));

	for (const name of SLOT_NAMES) {
		it(`${name}: looked up once, by its gateway handle; its mount renders the handle and keeps its fallback / absent guard`, () => {
			const mount = MOUNTS[name];
			const lookup = `slotGate('${name}'`;
			expect(sources.filter((s) => s.text.includes(lookup)).map((s) => s.rel)).toEqual([GATEWAY]);
			expect(read(GATEWAY)).toMatch(new RegExp(`export const ${mount.handle} = /\\*#__PURE__\\*/ slotGate\\('${name.replace('.', '\\.')}'`));
			const text = read(mount.file);
			expect(text).toMatch(mount.keeps);
			expect(text).toMatch(/from '~\/platform\/gateway'/);
		});
	}

	for (const { file, choice } of VIEW_CHOICES) {
		it(`${file}: chooses the brand mount only when its view exists, and keeps today's component as the fallback`, () => {
			expect(read(file)).toMatch(choice);
		});
	}

	it('getSlot is called only inside the gateway factories (platform/gateway/gate.tsx)', () => {
		expect(sources.filter((s) => /\bgetSlot\(/.test(s.text) && s.rel !== 'components/slots/index.ts').map((s) => s.rel)).toEqual(['platform/gateway/gate.tsx']);
	});

	it('no mount file imports the slot lookup or the virtual module', () => {
		for (const { file } of Object.values(MOUNTS)) {
			const text = read(file);
			expect(text).not.toContain("from '~/components/slots'");
			expect(text).not.toContain('virtual:sellright-brand-slots');
		}
	});

	it('the virtual module is imported from exactly one app file (slots/index.ts)', () => {
		const importers = sources.filter((s) => /from 'virtual:sellright-brand-slots'/.test(s.text)).map((s) => s.rel);
		expect(importers).toEqual(['components/slots/index.ts']);
	});
});
