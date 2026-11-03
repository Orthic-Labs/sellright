/**
 * NMI test-mode detection (#378).
 *
 * Test mode is an NMI-side switch (account-level "test mode" in the merchant portal, or `test_mode=enabled` on a
 * request): NMI approves valid cards without processing any charge, so an approved sale looks like a live one.
 * The Direct Post sale response carries no documented test flag, so a test-mode settlement is recognised by the
 * documented test cards on the read-only Query API result (`cc_bin` + masked `cc_number`), never from client input.
 *
 * Source: NMI Payment API documentation, "Testing Information" / "Test Data"
 * (https://secure.nmi.com/merchants/resources/integration/integration_portal.php, section #testing_information):
 * a test-mode account approves all valid cards without processing charges, and the documented test cards are
 * Visa 4111111111111111, MasterCard 5431111111111111, Discover 6011000991300009, American Express 341111111111111,
 * Diner's Club 30205252489926, JCB 3541963594572595 and Maestro 6799990100000000019. (The doc's own listing of the
 * one-off `test_mode` expiry is inconsistent: 1025 vs 10/25; we do not depend on it.)
 *
 * A match needs BOTH the leading digits (BIN, at least 6) and the last 4 of a documented card, so an ordinary card
 * is never classified as test by a BIN or last-4 coincidence alone.
 */
export const NMI_TEST_CARDS: ReadonlyArray<{ brand: string; pan: string }> = [
  { brand: 'visa', pan: '4111111111111111' },
  { brand: 'mastercard', pan: '5431111111111111' },
  { brand: 'discover', pan: '6011000991300009' },
  { brand: 'amex', pan: '341111111111111' },
  { brand: 'diners', pan: '30205252489926' },
  { brand: 'jcb', pan: '3541963594572595' },
  { brand: 'maestro', pan: '6799990100000000019' },
];

/** True when the BIN (first 6-8 digits) and last 4 digits are those of one documented NMI test card. */
export function isNmiTestCard(bin: string, last4: string): boolean {
  if (!/^\d{6,8}$/.test(bin) || !/^\d{4}$/.test(last4)) return false;
  return NMI_TEST_CARDS.some(({ pan }) => pan.length >= bin.length + 4 && pan.startsWith(bin) && pan.endsWith(last4));
}

/**
 * Query API card fields -> test-card verdict. `ccBin` is the BIN field; when it is absent the masked number must show
 * at least its first 6 digits (e.g. 411111******1111). Fully masked prefixes ("4xxxxxxxxxxx1111") prove nothing.
 */
export function nmiQueryShowsTestCard(fields: { ccBin?: string; ccNumber?: string }): boolean {
  const number = (fields.ccNumber ?? '').replace(/\s+/g, '');
  const last4 = /\d{4}$/.exec(number)?.[0];
  const bin = /^\d{6,8}$/.test(fields.ccBin ?? '') ? fields.ccBin! : /^\d{6,8}/.exec(number)?.[0];
  return !!last4 && !!bin && isNmiTestCard(bin, last4);
}

export interface NmiTestModeMark { detected: true; source: string }

/** The mark a verified result carries in `metadata.testMode` (read by finishAttempt). */
export function nmiTestModeMark(metadata: unknown): NmiTestModeMark | null {
  const mark = (metadata as { testMode?: { detected?: unknown; source?: unknown } } | null | undefined)?.testMode;
  return mark && mark.detected === true && typeof mark.source === 'string' ? { detected: true, source: mark.source } : null;
}
