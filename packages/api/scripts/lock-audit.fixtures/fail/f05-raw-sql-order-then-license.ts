// M1 + O2: raw SQL UPDATE "order" then raw UPDATE license (no set).
export async function f05(tx: any, id: string) {
  await tx.execute(`UPDATE "order" SET state = 'Refunded' WHERE id = ${id}`);
  await tx.execute(`UPDATE license SET revoked_at = now() WHERE order_id = ${id}`);
}
