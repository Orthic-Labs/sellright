import { NotificationTypeV2 } from '@apple/app-store-server-library';

export type StoreKitNotificationAction = 'revoke' | 'restore' | 'renew' | 'expire' | 'ignore';

/** Map only entitlement-changing App Store notifications to state changes.
 * Everything else is acknowledged after signature verification but mutates
 * nothing.
 *
 *  - revoke  — REFUND / REVOKE: the purchase was refunded or revoked; the
 *              license + purchase row flip to 'revoked'.
 *  - restore — REFUND_REVERSED: the refund was undone; flip back to 'active'.
 *  - renew   — DID_RENEW / RENEWAL_EXTENDED / RENEWAL_EXTENSION: subscription
 *              renewed; reactivate and adopt the signed expiresDate as the
 *              license's expiresAt.
 *  - expire  — EXPIRED / GRACE_PERIOD_EXPIRED: the entitlement window closed;
 *              flip to 'expired'. (DID_FAIL_TO_RENEW is deliberately NOT here —
 *              it marks entry into billing grace, and the subscription may
 *              still recover; only EXPIRED ends the entitlement.)
 *  - ignore  — TEST, SUBSCRIBED, METADATA_UPDATE, etc.: signature-verified
 *              bookkeeping only. */
export function storeKitNotificationAction(notificationType: string): StoreKitNotificationAction {
  if (notificationType === NotificationTypeV2.REFUND || notificationType === NotificationTypeV2.REVOKE) {
    return 'revoke';
  }
  if (notificationType === NotificationTypeV2.REFUND_REVERSED) return 'restore';
  if (
    notificationType === NotificationTypeV2.DID_RENEW ||
    notificationType === NotificationTypeV2.RENEWAL_EXTENDED ||
    notificationType === NotificationTypeV2.RENEWAL_EXTENSION
  ) {
    return 'renew';
  }
  if (notificationType === NotificationTypeV2.EXPIRED || notificationType === NotificationTypeV2.GRACE_PERIOD_EXPIRED) {
    return 'expire';
  }
  return 'ignore';
}
