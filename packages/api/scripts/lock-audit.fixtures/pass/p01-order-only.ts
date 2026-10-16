// Pass: order-only path, no licence lock, no order-after-licence.
export async function p01(tx: any, s: any) {
  await tx.update(s.order).set({ notes: 'x' });
  await tx.update(s.order).set({ notes: 'y' });
}
