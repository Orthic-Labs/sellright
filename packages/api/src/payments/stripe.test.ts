/**
 * WP3 unit tests — the server-side PaymentIntent verification (the security core)
 * and the refund no-ops. verifyIntent is pure, so these run with no Stripe key
 * and no SDK mock. The live end-to-end (real 3DS card → /pay → refund) is the
 * only piece that needs a sandbox key.
 */
import { describe, expect, it } from 'vitest';
import { verifyIntent, type IntentLike } from './stripe.js';
import { manualProvider, codProvider } from './provider.js';

const base = { orderCode: 'SR-ABC', amount: 2100, currency: 'usd' };
const intent = (over: Partial<IntentLike>): IntentLike => ({
  id: 'pi_123', amount: 2100, currency: 'usd', status: 'succeeded',
  metadata: { orderCode: 'SR-ABC' }, latest_charge: 'ch_1', ...over,
});

describe('verifyIntent — server-side trust boundary', () => {
  it('Settled when amount + currency + orderCode + status all match', () => {
    const r = verifyIntent(intent({}), base);
    expect(r).toMatchObject({ state: 'Settled', providerRef: 'pi_123', metadata: { latest_charge: 'ch_1' } });
  });

  it('currency match is case-insensitive', () => {
    expect(verifyIntent(intent({ currency: 'USD' }), { ...base, currency: 'usd' }).state).toBe('Settled');
  });

  it('Failed on amount mismatch (client cannot under-pay)', () => {
    const r = verifyIntent(intent({ amount: 100 }), base);
    expect(r.state).toBe('Failed');
    expect(r.errorMessage).toMatch(/amount\/currency/);
  });

  it('Failed on currency mismatch', () => {
    expect(verifyIntent(intent({ currency: 'eur' }), base).state).toBe('Failed');
  });

  it('Failed on orderCode mismatch (intent bound to a different order)', () => {
    const r = verifyIntent(intent({ metadata: { orderCode: 'SR-OTHER' } }), base);
    expect(r.state).toBe('Failed');
    expect(r.errorMessage).toMatch(/order mismatch/);
  });

  it('Failed when metadata is missing entirely', () => {
    expect(verifyIntent(intent({ metadata: null }), base).state).toBe('Failed');
  });

  it('Authorized when requires_capture (auth-only flow)', () => {
    expect(verifyIntent(intent({ status: 'requires_capture' }), base).state).toBe('Authorized');
  });

  it('Declined on any other status', () => {
    const r = verifyIntent(intent({ status: 'requires_payment_method' }), base);
    expect(r.state).toBe('Declined');
    expect(r.errorMessage).toMatch(/requires_payment_method/);
  });
});

describe('manual/cod refund no-ops', () => {
  it('manual refundPayment is a Settled no-op (money handled offline)', async () => {
    expect(await manualProvider.refundPayment!({ providerRef: null, amount: 100, currency: 'usd' }))
      .toEqual({ state: 'Settled', providerRef: null });
  });
  it('cod refundPayment is a Settled no-op', async () => {
    expect(await codProvider.refundPayment!({ providerRef: null, amount: 100, currency: 'usd' }))
      .toEqual({ state: 'Settled', providerRef: null });
  });
});
