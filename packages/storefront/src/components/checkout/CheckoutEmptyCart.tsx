import { component$ } from '@qwik.dev/core';
import { Link } from '@qwik.dev/router';

export const CheckoutEmptyCart = component$(() => (
  <div style="min-height:100vh;background:#F7F2EA;display:flex;align-items:center;justify-content:center;padding:40px 24px;">
    <div style="text-align:center;max-width:380px;">
      <svg style="width:48px;height:48px;margin:0 auto 28px;color:rgba(140,107,58,0.45);" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.2" d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z" />
      </svg>
      <h2 class="font-heading" style="font-size:28px;font-weight:400;color:#141210;letter-spacing:0.02em;margin-bottom:12px;">
        Your cart is empty
      </h2>
      <p style="font-size:14px;color:rgba(100,85,65,0.55);margin-bottom:36px;line-height:1.7;">
        Add some items to your cart to continue with checkout.
      </p>
      <Link href="/shop" style="display:inline-block;background:#141210;color:#FDFAF6;padding:14px 40px;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;text-decoration:none;border-radius:3px;">
        Continue Shopping
      </Link>
    </div>
  </div>
));
