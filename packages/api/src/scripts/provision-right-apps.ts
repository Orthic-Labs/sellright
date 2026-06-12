/**
 * Provision the Right Apps SellRight instance stores.
 *
 * Usage:
 *   ADMIN_EMAIL=you@example.com tsx src/scripts/provision-right-apps.ts
 *
 * Idempotent: stores are upserted by slug; ADMIN_EMAIL, when set, is granted
 * owner on each store if that admin user already exists.
 */
import { eq } from 'drizzle-orm';
import { unsafeUnscopedDb as db, pool } from '../db/client.js';
import * as s from '../db/schema.js';
import { normalizeEmail } from '../auth/email.js';

const RIGHT_APPS_STORES = [
  { slug: 'viewright', name: 'ViewRight' },
  { slug: 'coderight', name: 'CodeRight' },
  { slug: 'heardright', name: 'HeardRight' },
  { slug: 'mailright', name: 'MailRight' },
  { slug: 'scraperight', name: 'ScrapeRight' },
];

async function main() {
  const adminEmail = process.env.ADMIN_EMAIL ? normalizeEmail(process.env.ADMIN_EMAIL) : null;
  const admin = adminEmail
    ? (await db.select({ id: s.adminUser.id }).from(s.adminUser).where(eq(s.adminUser.email, adminEmail)).limit(1))[0]
    : null;

  if (adminEmail && !admin) {
    console.error(`[provision-right-apps] admin not found: ${adminEmail}`);
    process.exit(2);
  }

  for (const store of RIGHT_APPS_STORES) {
    const [row] = await db
      .insert(s.store)
      .values({ slug: store.slug, name: store.name, currency: 'USD', config: { payments: { stripe: true, manual: false, cod: false } } })
      .onConflictDoUpdate({
        target: s.store.slug,
        set: { name: store.name, currency: 'USD', updatedAt: new Date() },
      })
      .returning({ id: s.store.id, slug: s.store.slug });
    console.log(`[provision-right-apps] store ready: ${row!.slug}`);

    if (admin) {
      await db
        .insert(s.adminUserStore)
        .values({ adminUserId: admin.id, storeId: row!.id, role: 'owner' })
        .onConflictDoUpdate({ target: [s.adminUserStore.adminUserId, s.adminUserStore.storeId], set: { role: 'owner' } });
      console.log(`[provision-right-apps] owner grant: ${adminEmail} -> ${row!.slug}`);
    }
  }

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
