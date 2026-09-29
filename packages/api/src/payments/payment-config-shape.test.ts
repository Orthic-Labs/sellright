import { describe, expect, it } from 'vitest';
import { isPaymentMethodEnabled, mergePaymentMethodSetting, paymentMethodSetting } from './provider.js';
import { gatewayModeFromConfig } from './gateway-account.js';
import { sanitizePaymentSettingsPatch } from '../routes/admin-settings.js';

describe('payments.<method> config shapes', () => {
  it('treats a legacy boolean as enabled with the default (test) mode', () => {
    const config = { payments: { nmi: true, sezzle: false } };
    expect(isPaymentMethodEnabled(config, 'nmi')).toBe(true);
    expect(isPaymentMethodEnabled(config, 'sezzle')).toBe(false);
    expect(gatewayModeFromConfig(config, 'nmi')).toBe('test');
  });
  it('reads {enabled, mode} for both the enable check and the gateway mode', () => {
    const config = { payments: { nmi: { enabled: true, mode: 'live' }, sezzle: { mode: 'live' } } };
    expect(isPaymentMethodEnabled(config, 'nmi')).toBe(true);
    expect(gatewayModeFromConfig(config, 'nmi')).toBe('live');
    // mode without enabled stays fail-closed
    expect(isPaymentMethodEnabled(config, 'sezzle')).toBe(false);
    expect(paymentMethodSetting(config, 'sezzle')).toEqual({ enabled: false, mode: 'live' });
  });
  it('a verify-only object (readiness verifiedAt) never enables a method by itself', () => {
    expect(isPaymentMethodEnabled({ payments: { nmi: { live: { verifiedAt: 'x' } } } }, 'nmi')).toBe(false);
    expect(gatewayModeFromConfig({ payments: { nmi: { mode: 'bogus' } } }, 'nmi')).toBe('test');
  });
  it('merges admin patches without dropping readiness markers', () => {
    expect(mergePaymentMethodSetting(undefined, true)).toBe(true);
    expect(mergePaymentMethodSetting(true, { mode: 'live' })).toEqual({ enabled: true, mode: 'live' });
    const existing = { test: { verifiedAt: 't' }, enabled: true, mode: 'live' };
    expect(mergePaymentMethodSetting(existing, false)).toEqual({ ...existing, enabled: false });
    expect(mergePaymentMethodSetting(existing, { mode: 'test' })).toEqual({ ...existing, mode: 'test' });
  });
  it('accepts object patches for gateways only', () => {
    expect(sanitizePaymentSettingsPatch({ nmi: { enabled: true, mode: 'live' } })).toEqual({ nmi: { enabled: true, mode: 'live' } });
    expect(() => sanitizePaymentSettingsPatch({ stripe: { mode: 'live' } })).toThrow(/mode is not configurable/);
    expect(sanitizePaymentSettingsPatch({ stripe: { enabled: true } })).toEqual({ stripe: { enabled: true } });
  });
});
