import { describe, expect, it } from 'vitest';
import { vendurePaymentMetadataMode } from './orders.js';

describe('vendurePaymentMetadataMode', () => {
  it('reads boolean test/live flags with the key name carrying polarity', () => {
    expect(vendurePaymentMetadataMode({ testMode: true })).toBe('test');
    expect(vendurePaymentMetadataMode({ testMode: 'true' })).toBe('test');
    expect(vendurePaymentMetadataMode({ testMode: false })).toBe('live');
    expect(vendurePaymentMetadataMode({ live: true })).toBe('live');
    expect(vendurePaymentMetadataMode({ live: false })).toBe('test');
    expect(vendurePaymentMetadataMode({ sandbox: true })).toBe('test');
    expect(vendurePaymentMetadataMode({ isLive: 'false' })).toBe('test');
    expect(vendurePaymentMetadataMode({ test: true })).toBe('test');
    expect(vendurePaymentMetadataMode({ production: false })).toBe('test');
  });

  it('reads string-valued mode keys', () => {
    expect(vendurePaymentMetadataMode({ mode: 'test' })).toBe('test');
    expect(vendurePaymentMetadataMode({ mode: 'live' })).toBe('live');
    expect(vendurePaymentMetadataMode({ gatewayMode: 'sandbox' })).toBe('test');
    expect(vendurePaymentMetadataMode({ environment: 'production' })).toBe('live');
  });

  it('returns null for metadata without mode evidence', () => {
    expect(vendurePaymentMetadataMode(null)).toBeNull();
    expect(vendurePaymentMetadataMode({ card: 'visa' })).toBeNull();
    // A provider ref containing 'live'/'test' text is not a mode claim.
    expect(vendurePaymentMetadataMode({ paymentIntentId: 'pi_live_dd_1' })).toBeNull();
    expect(vendurePaymentMetadataMode({ mode: 'payment' })).toBeNull();
    expect(vendurePaymentMetadataMode({ testMode: 'yes' })).toBeNull();
    expect(vendurePaymentMetadataMode({ sezzleOrderUuid: 'abc' })).toBeNull();
  });
});
