/** Points-program settings form: parse + validate (mirrors the API's
 *  LoyaltySettingsSchema so errors show before a round-trip). */
export interface LoyaltySettings {
  enabled: boolean;
  earnRatePerDollar: number;
  pointsPerDollarOff: number;
  minRedeemPoints: number;
  maxRedeemPercentOfSubtotal: number | null;
  expiryDays: number | null;
}

export type LoyaltyForm = Record<'earnRatePerDollar' | 'pointsPerDollarOff' | 'minRedeemPoints' | 'maxRedeemPercentOfSubtotal' | 'expiryDays', string> & { enabled: boolean };

export const toLoyaltyForm = (s: LoyaltySettings): LoyaltyForm => ({
  enabled: s.enabled,
  earnRatePerDollar: String(s.earnRatePerDollar),
  pointsPerDollarOff: String(s.pointsPerDollarOff),
  minRedeemPoints: String(s.minRedeemPoints),
  maxRedeemPercentOfSubtotal: s.maxRedeemPercentOfSubtotal == null ? '' : String(s.maxRedeemPercentOfSubtotal),
  expiryDays: s.expiryDays == null ? '' : String(s.expiryDays),
});

const int = (v: string) => (v.trim() === '' ? NaN : Number(v));
const optInt = (v: string) => (v.trim() === '' ? null : Number(v));

export function validateLoyaltyForm(f: LoyaltyForm): { settings?: LoyaltySettings; error?: string } {
  const settings: LoyaltySettings = {
    enabled: f.enabled,
    earnRatePerDollar: int(f.earnRatePerDollar),
    pointsPerDollarOff: int(f.pointsPerDollarOff),
    minRedeemPoints: int(f.minRedeemPoints),
    maxRedeemPercentOfSubtotal: optInt(f.maxRedeemPercentOfSubtotal),
    expiryDays: optInt(f.expiryDays),
  };
  if (!Number.isInteger(settings.earnRatePerDollar) || settings.earnRatePerDollar < 0) return { error: 'Points earned per $1 must be a whole number ≥ 0.' };
  if (!Number.isInteger(settings.pointsPerDollarOff) || settings.pointsPerDollarOff < 1) return { error: 'Points per $1 off must be a whole number ≥ 1.' };
  if (!Number.isInteger(settings.minRedeemPoints) || settings.minRedeemPoints < 0) return { error: 'Minimum redemption must be a whole number ≥ 0.' };
  const cap = settings.maxRedeemPercentOfSubtotal;
  if (cap != null && (!Number.isInteger(cap) || cap < 1 || cap > 100)) return { error: 'Maximum redemption must be 1–100% (or blank for no cap).' };
  const exp = settings.expiryDays;
  if (exp != null && (!Number.isInteger(exp) || exp < 1)) return { error: 'Expiry must be a whole number of days (or blank for never).' };
  return { settings };
}
