/** Points-program settings form: parse + validate (mirrors the API's
 *  LoyaltySettingsSchema so errors show before a round-trip). */
export interface ProductMultiplier { productId: string; multiplier: number }

export interface LoyaltySettings {
  enabled: boolean;
  earnRatePerDollar: number;
  pointsPerDollarOff: number;
  minRedeemPoints: number;
  maxRedeemPercentOfSubtotal: number | null;
  expiryDays: number | null;
  reviewBonusPoints: number;
  reviewBonusVerifiedOnly: boolean;
  signupBonusPoints: number;
  signupBonusSince: string | null;
  firstOrderBonusPoints: number;
  birthdayBonusPoints: number;
  productMultipliers: ProductMultiplier[];
}

type TextKeys = 'earnRatePerDollar' | 'pointsPerDollarOff' | 'minRedeemPoints' | 'maxRedeemPercentOfSubtotal' | 'expiryDays'
  | 'reviewBonusPoints' | 'signupBonusPoints' | 'firstOrderBonusPoints' | 'birthdayBonusPoints';
export type LoyaltyForm = Record<TextKeys, string> & {
  enabled: boolean;
  reviewBonusVerifiedOnly: boolean;
  signupBonusSince: string | null;
  /** multiplier kept as text while editing */
  productMultipliers: Array<{ productId: string; multiplier: string }>;
};

export const toLoyaltyForm = (s: LoyaltySettings): LoyaltyForm => ({
  enabled: s.enabled,
  earnRatePerDollar: String(s.earnRatePerDollar),
  pointsPerDollarOff: String(s.pointsPerDollarOff),
  minRedeemPoints: String(s.minRedeemPoints),
  maxRedeemPercentOfSubtotal: s.maxRedeemPercentOfSubtotal == null ? '' : String(s.maxRedeemPercentOfSubtotal),
  expiryDays: s.expiryDays == null ? '' : String(s.expiryDays),
  reviewBonusPoints: String(s.reviewBonusPoints ?? 0),
  reviewBonusVerifiedOnly: s.reviewBonusVerifiedOnly ?? true,
  signupBonusPoints: String(s.signupBonusPoints ?? 0),
  signupBonusSince: s.signupBonusSince ?? null,
  firstOrderBonusPoints: String(s.firstOrderBonusPoints ?? 0),
  birthdayBonusPoints: String(s.birthdayBonusPoints ?? 0),
  productMultipliers: (s.productMultipliers ?? []).map((m) => ({ productId: m.productId, multiplier: String(m.multiplier) })),
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
    reviewBonusPoints: int(f.reviewBonusPoints),
    reviewBonusVerifiedOnly: f.reviewBonusVerifiedOnly,
    signupBonusPoints: int(f.signupBonusPoints),
    signupBonusSince: f.signupBonusSince,
    firstOrderBonusPoints: int(f.firstOrderBonusPoints),
    birthdayBonusPoints: int(f.birthdayBonusPoints),
    productMultipliers: f.productMultipliers.map((m) => ({ productId: m.productId, multiplier: Number(m.multiplier) })),
  };
  if (!Number.isInteger(settings.earnRatePerDollar) || settings.earnRatePerDollar < 0) return { error: 'Points earned per $1 must be a whole number ≥ 0.' };
  if (!Number.isInteger(settings.pointsPerDollarOff) || settings.pointsPerDollarOff < 1) return { error: 'Points per $1 off must be a whole number ≥ 1.' };
  if (!Number.isInteger(settings.minRedeemPoints) || settings.minRedeemPoints < 0) return { error: 'Minimum redemption must be a whole number ≥ 0.' };
  const cap = settings.maxRedeemPercentOfSubtotal;
  if (cap != null && (!Number.isInteger(cap) || cap < 1 || cap > 100)) return { error: 'Maximum redemption must be 1–100% (or blank for no cap).' };
  const exp = settings.expiryDays;
  if (exp != null && (!Number.isInteger(exp) || exp < 1)) return { error: 'Expiry must be a whole number of days (or blank for never).' };
  const bonuses: Array<[number, string]> = [
    [settings.reviewBonusPoints, 'Review bonus'], [settings.signupBonusPoints, 'Sign-up bonus'],
    [settings.firstOrderBonusPoints, 'First-order bonus'], [settings.birthdayBonusPoints, 'Birthday bonus'],
  ];
  for (const [v, label] of bonuses) {
    if (!Number.isInteger(v) || v < 0) return { error: `${label} must be a whole number of points ≥ 0 (0 = off).` };
  }
  for (const m of settings.productMultipliers) {
    if (!Number.isFinite(m.multiplier) || m.multiplier < 1 || m.multiplier > 100) return { error: 'Each product multiplier must be between 1 and 100.' };
  }
  return { settings };
}
