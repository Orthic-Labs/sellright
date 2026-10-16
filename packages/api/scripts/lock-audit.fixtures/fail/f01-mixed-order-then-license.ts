// M1 + O2: order lock then licence lock, no withLockedSet, not allow-listed.
export async function f01(tx: any, s: any) {
  await tx.update(s.order).set({ state: 'Refunded' });
  await tx.update(s.license).set({ revokedAt: new Date() });
}
