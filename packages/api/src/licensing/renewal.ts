/** Extend a subscription entitlement by one cycle. Stacks on the later of the
 *  current end or now, so renewing early adds time and renewing after a lapse
 *  restarts from now. null duration = perpetual (nothing to extend). Pure —
 *  money/entitlement-critical, so it's unit-tested. */
export function extendEntitlement(current: Date | null, durationDays: number | null, now = new Date()): Date | null {
  if (durationDays == null) return null;
  const base = current && current.getTime() > now.getTime() ? current : now;
  return new Date(base.getTime() + durationDays * 86_400_000);
}
