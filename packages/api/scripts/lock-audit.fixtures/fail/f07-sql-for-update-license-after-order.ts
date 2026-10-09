// O2 + M1: order lock then raw SQL FOR UPDATE on license.
export async function f07(tx: any, s: any, id: string) {
  await tx.update(s.order).set({ notes: 'x' });
  await tx.execute(`SELECT 1 FROM license WHERE id = ${id} FOR UPDATE`);
}
