import { describe, expect, it } from 'vitest';
import { NotificationTypeV2 } from '@apple/app-store-server-library';
import { storeKitNotificationAction } from './storekit-notifications.js';

describe('storeKitNotificationAction', () => {
  it('revokes refunded or revoked purchases', () => {
    expect(storeKitNotificationAction(NotificationTypeV2.REFUND)).toBe('revoke');
    expect(storeKitNotificationAction(NotificationTypeV2.REVOKE)).toBe('revoke');
  });

  it('restores a reversed refund', () => {
    expect(storeKitNotificationAction(NotificationTypeV2.REFUND_REVERSED)).toBe('restore');
  });

  it('renews on subscription renewal events', () => {
    expect(storeKitNotificationAction(NotificationTypeV2.DID_RENEW)).toBe('renew');
    expect(storeKitNotificationAction(NotificationTypeV2.RENEWAL_EXTENDED)).toBe('renew');
    expect(storeKitNotificationAction(NotificationTypeV2.RENEWAL_EXTENSION)).toBe('renew');
  });

  it('expires a subscription whose entitlement window has ended', () => {
    expect(storeKitNotificationAction(NotificationTypeV2.EXPIRED)).toBe('expire');
    expect(storeKitNotificationAction(NotificationTypeV2.GRACE_PERIOD_EXPIRED)).toBe('expire');
  });

  it('does not mutate entitlement for test or unrelated notifications', () => {
    expect(storeKitNotificationAction(NotificationTypeV2.TEST)).toBe('ignore');
    expect(storeKitNotificationAction(NotificationTypeV2.METADATA_UPDATE)).toBe('ignore');
    // DID_FAIL_TO_RENEW is a grace-period entry, not an entitlement loss —
    // the subscription may still recover; only EXPIRED ends it.
    expect(storeKitNotificationAction(NotificationTypeV2.DID_FAIL_TO_RENEW)).toBe('ignore');
    expect(storeKitNotificationAction(NotificationTypeV2.SUBSCRIBED)).toBe('ignore');
  });
});
