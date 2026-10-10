// O2: loyalty advisory (L5) then order update (L3) (STOREKIT §5.7 A.4, R2-3 shape).
export async function f03(tx: any, s: any, customerId: string) {
  await tx.execute(`SELECT pg_advisory_xact_lock(hashtextextended('loyalty:x:${customerId}', 0))`);
  await tx.update(s.order).set({ metadata: {} });
}
