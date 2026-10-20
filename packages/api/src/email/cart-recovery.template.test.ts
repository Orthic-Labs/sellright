import { describe, expect, it } from 'vitest';
import { cartRecovery, type StoreCtx } from './templates.js';

const store: StoreCtx = { name: 'Brand <B>', currency: 'USD', storefrontUrl: 'https://b.example', fromEmail: 'hi@b.example' };

describe('cartRecovery template', () => {
  const m = cartRecovery(store, { url: 'https://b.example/v1/shop/cart/recover/x?exp=1&sig=ab', lines: [{ name: 'Mug <script>', quantity: 2 }, { name: 'Tee — L', quantity: 1 }] });
  it('has the fixed subject and lists lines with quantities, escaped', () => {
    expect(m.subject).toContain('You left something in your cart');
    expect(m.html).toContain('Mug &lt;script&gt; × 2');
    expect(m.html).toContain('Tee — L × 1');
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('Brand &lt;B&gt;');
  });
  it('has exactly one call-to-action pointing at the signed link', () => {
    expect(m.html.match(/Return to your cart/g)).toHaveLength(1);
    expect(m.html).toContain('href="https://b.example/v1/shop/cart/recover/x?exp=1&amp;sig=ab"');
    expect(m.text).toContain('b.example/v1/shop/cart/recover/x');
  });
});
