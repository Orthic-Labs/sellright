import { ssrRenderToDom } from '@qwik.dev/core/testing';
import { describe, expect, it } from 'vitest';
import { ProductMobileBar } from './ProductMobileBar';

const render = async (waitlistAvailable: boolean, soldOut = true) => (await ssrRenderToDom(
  <ProductMobileBar
    product={{ name: 'Anzu' }} selectedVariant={{ value: undefined }} displayPrice={{ value: 7500 }}
    allVariantsSoldOut={{ value: soldOut }} waitlistAvailable={waitlistAvailable}
    isPreOrder={{ value: false }} showFromPrefix={{ value: false }} isAddingToCart={{ value: false }}
    isOutOfStock={{ value: soldOut }} ctaClass={{ value: 'sr-cta-btn ready' }} ctaDisabled={{ value: false }}
    showCtaTooltip={{ value: false }} ctaTooltipFading={{ value: false }}
  />, {})).document;

describe('sold-out mobile waitlist affordance', () => {
  it('offers Notify me only when sold out & parent confirms an active waitlist slot', async () => {
    const active = await render(true);
    expect(active.querySelector('button')?.textContent).toBe('Notify me');
    expect(active.querySelector('button')?.getAttribute('type')).toBe('button');
    const absent = await render(false);
    expect(absent.querySelector('button')?.textContent).toBe('Out of Stock');
  });
  it('retains purchasing action for stocked products', async () => {
    const document = await render(true, false);
    expect(document.querySelector('button')?.textContent).toBe('Add to cart');
    expect(document.querySelector('button')?.disabled).toBe(false);
  });
});
