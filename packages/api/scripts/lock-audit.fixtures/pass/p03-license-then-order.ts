// Pass ordering only: licence (L2) then order (L3) is ascending. (Mixed, so this fixture is
// checked with an allow-list entry in the unit test to prove the ordering rule alone passes.)
export async function p03(tx: any, s: any) {
  await tx.update(s.license).set({ revokedAt: new Date() });
  await tx.update(s.order).set({ notes: 'x' });
}
