// Free-trial term. A trial is just a normal paid-tier license — issued to an
// email and activated through the standard licenses/activate flow — with a
// short hard expiry. It therefore rides the existing license/activation/refresh/
// expiry machinery with NO new tables: the device seat is bound at activation,
// the signed token's exp = the license expiry, and `findActivationByToken`
// returns null once the license expires, so the app drops to free automatically.

export const TRIAL_DAYS = 14;

/** Absolute expiry for a trial license started at `now`. `days` lets a store
 *  or app configure its own trial length; the default is TRIAL_DAYS. */
export function trialExpiresAt(now: Date = new Date(), days: number = TRIAL_DAYS): Date {
  return new Date(now.getTime() + days * 86_400_000);
}
