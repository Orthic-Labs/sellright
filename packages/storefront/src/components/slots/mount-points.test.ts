// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SLOT_NAMES, type SlotName } from './registry';

// One test per mount point (plan A17). Components are not rendered here (vitest runs without a Qwik DOM); this checks the
// contract each mount file must keep: it asks for its slot by name, from exactly one place, and keeps its fallback.
// Rendering is covered by e2e/slots.spec.ts against compiled fixture slots.
const SRC = fileURLToPath(new URL('../..', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

interface Mount {
	file: string;
	/** Text the mount file must still contain: the fallback markup or the "absent renders nothing" guard. */
	keeps: RegExp;
}

const MOUNTS: Record<SlotName, Mount> = {
	'cart.free-shipping-progress': { file: 'components/cart-contents/CartContents.tsx', keeps: /\{FreeShippingProgressSlot && \(/ },
	'checkout.loyalty-redemption': { file: 'components/checkout/CheckoutOrderSummary.tsx', keeps: /getSlot\('checkout\.loyalty-redemption'\) \?\? LoyaltyRedeem/ },
	'payment.badges': { file: 'components/footer/footer.tsx', keeps: /\{PaymentBadgesSlot && <PaymentBadgesSlot placement="footer" \/>\}/ },
	'pdp.payment-widget': { file: 'routes/products/[...slug]/ProductPageView.tsx', keeps: /\{PaymentWidgetSlot && <PaymentWidgetSlot priceCents=\{widgetPriceCents\} \/>\}/ },
	'pdp.guarantee-modal': { file: 'routes/products/[...slug]/ProductPageView.tsx', keeps: /\{GuaranteeModalSlot && <GuaranteeModalSlot / },
	'pdp.waitlist': { file: 'routes/products/[...slug]/ProductPageView.tsx', keeps: /\{WaitlistSlot && <WaitlistSlot / },
	'account.order-card': { file: 'routes/account/orders/index.tsx', keeps: /if \(OrderCardSlot\) return <OrderCardSlot[^>]*\/>;\n\s*return \(\n\s*<a/ },
	'account.sustainability-badge': { file: 'routes/account/index.tsx', keeps: /\{SustainabilityBadgeSlot && <SustainabilityBadgeSlot / },
	'legal.copy': { file: 'routes/privacy/index.tsx', keeps: /\{LegalCopy \? <LegalCopy section="privacy\.payment-processors" \/> : 'payment service providers'\}/ },
};

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
		.filter((f) => !f.includes('__fixtures__'))
		.map((f) => ({ f, text: fs.readFileSync(f, 'utf8') }));

	for (const name of SLOT_NAMES) {
		it(`${name}: mounted once, in its file, with its fallback / absent guard intact`, () => {
			const mount = MOUNTS[name];
			const call = `getSlot('${name}')`;
			const hits = sources.filter((s) => s.text.includes(call)).map((s) => path.relative(SRC, s.f).split(path.sep).join('/'));
			expect(hits).toEqual([mount.file]);
			const text = read(mount.file);
			expect(text.split(call).length - 1).toBe(1);
			expect(text).toMatch(mount.keeps);
		});
	}

	it('mount files import the slot lookup, not the virtual module', () => {
		for (const { file } of Object.values(MOUNTS)) {
			const text = read(file);
			expect(text).toContain("from '~/components/slots'");
			expect(text).not.toContain('virtual:sellright-brand-slots');
		}
	});

	it('the virtual module is imported from exactly one app file (slots/index.ts)', () => {
		const importers = sources.filter((s) => /from 'virtual:sellright-brand-slots'/.test(s.text)).map((s) => path.relative(SRC, s.f).split(path.sep).join('/'));
		expect(importers).toEqual(['components/slots/index.ts']);
	});
});
