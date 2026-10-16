// O2: cart FOR UPDATE (L5) before licence delete (L2): cart must not precede L2–L4.
export async function f06(tx: any, s: any) {
  await tx.select().from(s.cart).for('update');
  await tx.delete(s.license);
}
