// O2 + M1: order lock followed by licence delete (admin purge shape, STOREKIT §5.7 A.4).
export async function f02(tx: any, s: any) {
  await tx.select().from(s.order).for('update');
  await tx.delete(s.license);
}
