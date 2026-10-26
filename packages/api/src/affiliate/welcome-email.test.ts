/**
 * Affiliate welcome mail content (DD affiliate-welcome body.hbs): coupon code,
 * the discount it gives, 10% of product subtotal, monthly payouts, reply to
 * recover — and the dashboard link carries the token in the URL fragment.
 */
import { describe, expect, it } from 'vitest';
import { affiliateTokenRotated, affiliateWelcome } from '../email/templates-ops.js';

const store = { name: 'Test Store', currency: 'USD', storefrontUrl: 'https://shop.test', fromEmail: 'hi@shop.test' };
const accessUrl = 'https://shop.test/affiliate#t=abcdef0123456789abcdef0123456789';

describe('affiliateWelcome', () => {
  const m = affiliateWelcome(store, { code: 'CREATOR15', dashboardUrl: 'https://shop.test/affiliate', accessUrl, discount: '15%', commissionPct: 10 });

  it('names the code, the customer discount, the commission and monthly payouts', () => {
    expect(m.subject).toContain("You're a Test Store affiliate");
    for (const out of [m.html, m.text]) {
      expect(out).toContain('CREATOR15');
      expect(out).toContain('15% off');
      expect(out).toContain('10%');
      expect(out).toContain("product subtotal (shipping and tax excluded)");
      expect(out).toContain('Payouts go out monthly');
      expect(out).toContain('just reply to this email');
    }
  });

  it('links the dashboard with #t= (never ?t=)', () => {
    expect(m.html).toContain(`href="${accessUrl}"`);
    expect(m.text).toContain('#t=abcdef0123456789abcdef0123456789');
    expect(m.html).not.toContain('?t=');
    expect(m.text).not.toContain('?t=');
  });

  it('falls back to a generic discount phrase when the value is unknown', () => {
    const g = affiliateWelcome(store, { code: 'X', dashboardUrl: 'u', accessUrl, discount: null });
    expect(g.text).toContain('gives your audience a discount');
  });
});

describe('affiliateTokenRotated', () => {
  it('uses the fragment link too', () => {
    const m = affiliateTokenRotated(store, { code: 'CREATOR15', dashboardUrl: 'u', accessUrl });
    expect(m.html).toContain('#t=');
    expect(m.html).not.toContain('?t=');
  });
});
