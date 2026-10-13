// Regression: ProductCard fails closed on stock. Omitted `inStock` (the gateway/search/collection responses may omit it)
// must render the unavailable state, and the pre-order flag must never present without a live `inStock === true`.
import { QwikRouterMockProvider } from '@qwik.dev/router';
import { ssrRenderToDom } from '@qwik.dev/core/testing';
import { describe, expect, it } from 'vitest';
import ProductCard from './ProductCard';

const render = async (props: { inStock?: boolean; isPreOrder?: boolean; salePrice?: number | null }) =>
	(
		await ssrRenderToDom(
			<QwikRouterMockProvider>
				<ProductCard slug="tee" name="Tee" price={5000} preOrderPrice={4000} {...props} />
			</QwikRouterMockProvider>,
			{},
		)
	).document.body.innerHTML;

describe('ProductCard stock — fails closed', () => {
	it('omitted inStock + pre-order -> sold out / notify, no pre-order presentation', async () => {
		const html = await render({ isPreOrder: true });
		expect(html).toContain('Sold Out');
		expect(html).toContain('Notify me');
		expect(html).not.toContain('Pre-order');
	});

	it('explicit inStock=false + pre-order -> sold out / notify, no pre-order presentation', async () => {
		const html = await render({ inStock: false, isPreOrder: true });
		expect(html).toContain('Sold Out');
		expect(html).toContain('Notify me');
		expect(html).not.toContain('Pre-order');
	});

	it('explicit inStock=true + pre-order -> pre-order badge and label, not sold out', async () => {
		const html = await render({ inStock: true, isPreOrder: true });
		expect(html).toContain('Pre-order now');
		expect(html).toContain('>Pre-order<');
		expect(html).not.toContain('Sold Out');
		expect(html).not.toContain('Notify me');
	});

	it('omitted inStock + sale price -> no Sale badge', async () => {
		const html = await render({ salePrice: 4000 });
		expect(html).toContain('Sold Out');
		expect(html).not.toContain('>Sale<');
	});

	it('explicit inStock=true, plain -> view product, no badges', async () => {
		const html = await render({ inStock: true });
		expect(html).toContain('View product');
		expect(html).not.toContain('Sold Out');
		expect(html).not.toContain('Notify me');
	});
});
