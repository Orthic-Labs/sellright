import { describe, expect, it } from 'vitest';
import { isUiPermissionKey, mergeStaffPermissions, sanitizePaymentSettingsPatch, sanitizeWebhookEndpointPatch } from './admin-settings.js';

/**
 * Backward-compat contract for the PUT /staff/{id}/permissions handler:
 *
 *   - unknown keys (anything outside UI_PERMISSION_KEYS) MUST round-trip
 *     untouched through a save;
 *   - known UI keys are written through verbatim (true only — false = absent);
 *   - the previous payload may be null (freshly-created admin_user_store row
 *     with no permissions column default).
 *
 * The bug this guards against: opening the editor and clicking "Save" used to
 * overwrite the entire permissions column with only the UI-managed keys, which
 * silently dropped any grants that were set by other means.
 */
describe('mergeStaffPermissions', () => {
  it('preserves unknown keys when saving the UI allow-list', () => {
    const next = mergeStaffPermissions(
      { giftcards: true, webhooks: true, analytics: true, discounts: true },
      { giftcards: false, webhooks: true },
    );
    expect(next).toEqual({ analytics: true, discounts: true, webhooks: true });
    // Unknown keys survive, even when we tried to "unset" them by omitting them
    // from the UI payload (false is implicit for UI keys, not destructive).
    expect(next).not.toHaveProperty('giftcards');
  });

  it('handles a null previous payload (fresh admin_user_store row)', () => {
    expect(mergeStaffPermissions(null, { giftcards: true })).toEqual({ giftcards: true });
    expect(mergeStaffPermissions(null, {})).toEqual({});
  });

  it('handles an empty previous payload', () => {
    expect(mergeStaffPermissions({}, { webhooks: true })).toEqual({ webhooks: true });
    expect(mergeStaffPermissions({}, {})).toEqual({});
  });

  it('treats UI key = false as absent (does not write false into the row)', () => {
    const next = mergeStaffPermissions({ giftcards: true }, { giftcards: false });
    expect(next).toEqual({}); // giftcards removed from the row, not stored as false
  });

  it('preserves multiple unknown keys and overlays UI keys together', () => {
    const next = mergeStaffPermissions(
      { analytics: true, discounts: true, giftcards: true },
      { giftcards: false, webhooks: true },
    );
    expect(next).toEqual({ analytics: true, discounts: true, webhooks: true });
  });
});

describe('isUiPermissionKey', () => {
  it('accepts known UI keys', () => {
    expect(isUiPermissionKey('giftcards')).toBe(true);
    expect(isUiPermissionKey('webhooks')).toBe(true);
  });

  it('rejects unknown keys (server throws 400 on these)', () => {
    expect(isUiPermissionKey('analytics')).toBe(false); // genuinely not a permission key (refunds IS one now, SEC-6)
    expect(isUiPermissionKey('')).toBe(false);
    expect(isUiPermissionKey('GIFTCARDS')).toBe(false); // exact-match, not case-insensitive
  });
});

describe('sanitizePaymentSettingsPatch', () => {
  it('accepts only implemented payment providers', () => {
    expect(sanitizePaymentSettingsPatch({ cod: false, manual: true, stripe: true })).toEqual({
      cod: false,
      manual: true,
      stripe: true,
    });
    expect(() => sanitizePaymentSettingsPatch({ paypal: true })).toThrow(/unsupported payment provider/);
    expect(() => sanitizePaymentSettingsPatch({ nmi: true, sezzle: true })).toThrow(/unsupported payment provider/);
  });
});

describe('sanitizeWebhookEndpointPatch', () => {
  it('normalizes a safe webhook url and preserves other patch fields', async () => {
    await expect(sanitizeWebhookEndpointPatch({
      url: 'https://merchant.example/hook#secret',
      topics: ['order.created'],
      enabled: true,
    }, {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    })).resolves.toEqual({
      url: 'https://merchant.example/hook',
      topics: ['order.created'],
      enabled: true,
    });
  });

  it('rejects private webhook callback urls before they reach the database patch', async () => {
    await expect(sanitizeWebhookEndpointPatch({
      url: 'http://127.0.0.1:3300/internal',
      enabled: true,
    })).rejects.toThrow(/private/);
  });

  it('does not perform DNS validation when the patch does not include a url', async () => {
    await expect(sanitizeWebhookEndpointPatch({ enabled: false })).resolves.toEqual({ enabled: false });
  });
});
