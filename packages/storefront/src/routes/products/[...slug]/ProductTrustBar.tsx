import { component$ } from '@qwik.dev/core';
import { theme } from '~/theme/theme.config';

export const ProductTrustBar = component$(() => (
  <div class="sr-trust">
    <div class="sr-trust-item">
      <svg class="sr-trust-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 18H3a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h2l3-5h4l-1 5h5.5a2 2 0 0 1 1.6 3.2L13 18h-4"/><circle cx="7.5" cy="18" r="2"/><circle cx="17.5" cy="18" r="2"/><path d="M15 18h2.5"/></svg>
      <div class="sr-trust-text">
        <span class="sr-trust-val">{theme.policies.shipping.label}</span>
        <span class="sr-trust-lbl">{theme.policies.shipping.sub}</span>
      </div>
    </div>
    <div class="sr-trust-item">
      <svg class="sr-trust-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 18 0 9 9 0 0 0-18 0"/><path d="M12 7v5l3 3"/></svg>
      <div class="sr-trust-text">
        <span class="sr-trust-val">{theme.policies.returns.label}</span>
        <span class="sr-trust-lbl">{theme.policies.returns.sub}</span>
      </div>
    </div>
    <div class="sr-trust-item">
      <svg class="sr-trust-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
      <div class="sr-trust-text">
        <span class="sr-trust-val">{theme.policies.payment.label}</span>
        <span class="sr-trust-lbl">{theme.policies.payment.sub}</span>
      </div>
    </div>
  </div>
));
