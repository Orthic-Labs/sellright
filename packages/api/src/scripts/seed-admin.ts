/**
 * Seed (or reset) an admin user and grant them `owner` on every store.
 * Usage: tsx src/scripts/seed-admin.ts <email> <password>
 * Idempotent: re-running updates the password and re-grants store access.
 */
import { db, pool } from '../db/client.js';
import * as s from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { hashPassword } from '../auth/password.js';

async function main() {
  const [email, password] = process.argv.slice(2);
  if (!email || !password) {
    console.error('usage: tsx src/scripts/seed-admin.ts <email> <password>');
    process.exit(1);
  }
  const passwordHash = await hashPassword(password);

  const existing = await db.select({ id: s.adminUser.id }).from(s.adminUser).where(eq(s.adminUser.email, email)).limit(1);
  let adminId: string;
  if (existing.length) {
    adminId = existing[0]!.id;
    await db.update(s.adminUser).set({ passwordHash }).where(eq(s.adminUser.id, adminId));
    console.log(`[seed-admin] updated password for ${email} (${adminId})`);
  } else {
    const [created] = await db.insert(s.adminUser).values({ email, passwordHash }).returning({ id: s.adminUser.id });
    adminId = created!.id;
    console.log(`[seed-admin] created admin ${email} (${adminId})`);
  }

  const stores = await db.select({ id: s.store.id, slug: s.store.slug }).from(s.store);
  for (const st of stores) {
    await db
      .insert(s.adminUserStore)
      .values({ adminUserId: adminId, storeId: st.id, role: 'owner' })
      .onConflictDoUpdate({ target: [s.adminUserStore.adminUserId, s.adminUserStore.storeId], set: { role: 'owner' } });
    console.log(`[seed-admin] granted owner on ${st.slug}`);
  }

  await pool.end();
  console.log('[seed-admin] done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
