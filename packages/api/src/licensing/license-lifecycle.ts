export type LicenseKind = 'trial' | 'lifetime' | 'term';
export type EntitlementStage = 'time_bound' | 'provisional' | 'final';

export interface LicenseLifecyclePlan {
  licenseKind: LicenseKind;
  entitlementStage: EntitlementStage;
  licenseIssuedAtUnix: number;
  confirmationDueAtUnix: number | null;
  tokenExpiresAtUnix: number;
  /** UI-only date. Native authorization trusts only the signed token. */
  validUntil: Date | null;
}

const DAY_SECONDS = 86_400;
export const LIFETIME_CONFIRMATION_DAYS = 30;
export const FINAL_LIFETIME_EXP_UNIX = 253_402_300_799; // 9999-12-31T23:59:59Z
const ROLLING_TERM_TOKEN_DAYS = 30;

export interface LifecycleWindows {
  /** Days from license issuance during which a lifetime license's tokens are
   *  provisional (refund/chargeback window). Default 30. */
  lifetimeConfirmationDays?: number;
  /** Rolling token length for term (non-trial, time-bound) licenses. Default 30. */
  rollingTermTokenDays?: number;
  /** exp used for the final, post-confirmation lifetime token. */
  finalLifetimeExpUnix?: number;
}

function unix(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/**
 * Plan the signed offline entitlement from server-owned license facts.
 *
 * Lifetime purchases get one fixed provisional window from license issuance,
 * not a rolling window from activation. At/after that boundary the activate or
 * refresh request itself is the mandatory online active/refund check; only an
 * active license receives the final offline token.
 */
export function planLicenseLifecycle(
  license: { createdAt: Date; expiresAt: Date | null; metadata: unknown },
  now: Date = new Date(),
  windows: LifecycleWindows = {},
): LicenseLifecyclePlan {
  const confirmationDays = windows.lifetimeConfirmationDays ?? LIFETIME_CONFIRMATION_DAYS;
  const rollingTermDays = windows.rollingTermTokenDays ?? ROLLING_TERM_TOKEN_DAYS;
  const finalLifetimeExp = windows.finalLifetimeExpUnix ?? FINAL_LIFETIME_EXP_UNIX;
  const licenseIssuedAtUnix = unix(license.createdAt);
  const nowUnix = unix(now);
  const metadata = license.metadata && typeof license.metadata === 'object' && !Array.isArray(license.metadata)
    ? license.metadata as Record<string, unknown>
    : {};

  if (license.expiresAt) {
    const hardExpiry = unix(license.expiresAt);
    const isTrial = metadata.kind === 'trial';
    return {
      licenseKind: isTrial ? 'trial' : 'term',
      entitlementStage: 'time_bound',
      licenseIssuedAtUnix,
      confirmationDueAtUnix: null,
      tokenExpiresAtUnix: isTrial
        ? hardExpiry
        : Math.min(hardExpiry, nowUnix + rollingTermDays * DAY_SECONDS),
      validUntil: license.expiresAt,
    };
  }

  const confirmationDueAtUnix = licenseIssuedAtUnix + confirmationDays * DAY_SECONDS;
  if (nowUnix < confirmationDueAtUnix) {
    return {
      licenseKind: 'lifetime',
      entitlementStage: 'provisional',
      licenseIssuedAtUnix,
      confirmationDueAtUnix,
      tokenExpiresAtUnix: confirmationDueAtUnix,
      validUntil: new Date(confirmationDueAtUnix * 1000),
    };
  }

  return {
    licenseKind: 'lifetime',
    entitlementStage: 'final',
    licenseIssuedAtUnix,
    confirmationDueAtUnix,
    tokenExpiresAtUnix: finalLifetimeExp,
    validUntil: null,
  };
}
