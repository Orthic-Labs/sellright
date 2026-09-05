import { eq } from 'drizzle-orm';
import { unsafeUnscopedDb as db, pool } from '../db/client.js';
import * as s from '../db/schema.js';
import { normalizeEmail } from '../auth/email.js';
import { hashPassword } from '../auth/password.js';
import { env } from '../env.js';

function parseHostnames(raw: string | undefined): string[] {
  if (!raw) return [];
  const out = new Set<string>();
  for (const value of raw.split(',')) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    let hostname: string;
    try {
      hostname = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname;
    } catch {
      throw new Error(`invalid BOOTSTRAP_STORE_HOSTNAMES entry: ${trimmed}`);
    }
    hostname = hostname.toLowerCase().replace(/\.$/u, '');
    if (!hostname) throw new Error(`invalid BOOTSTRAP_STORE_HOSTNAMES entry: ${trimmed}`);
    out.add(hostname);
  }
  return [...out];
}

/**
 * Create-only first-run bootstrap for the packaged appliance.
 *
 * The script is disabled unless BOOTSTRAP_STORE_SLUG is set, so existing
 * deployments are unaffected even if they already use ADMIN_EMAIL/PASSWORD for
 * other scripts. Re-running never changes an existing store's settings and
 * never resets an existing password hash; it only fills a missing password and
 * ensures the configured admin owns the bootstrap store.
 */
async function main(): Promise<void> {
  const slug = env.BOOTSTRAP_STORE_SLUG?.trim().toLowerCase();
  if (!slug) {
    console.log('[bootstrap] BOOTSTRAP_STORE_SLUG not set; skipping first-run bootstrap');
    return;
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug)) {
    throw new Error('BOOTSTRAP_STORE_SLUG must contain lowercase letters/numbers separated by single hyphens');
  }
  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) {
    throw new Error('BOOTSTRAP_STORE_SLUG requires ADMIN_EMAIL and ADMIN_PASSWORD');
  }
  if (env.ADMIN_PASSWORD.length < 12) {
    throw new Error('ADMIN_PASSWORD must be at least 12 characters for first-run bootstrap');
  }

  const email = normalizeEmail(env.ADMIN_EMAIL);
  const name = env.BOOTSTRAP_STORE_NAME?.trim() || slug;
  const currency = env.BOOTSTRAP_STORE_CURRENCY ?? 'USD';
  const hostnames = parseHostnames(env.BOOTSTRAP_STORE_HOSTNAMES);

  let [store] = await db.select({ id: s.store.id }).from(s.store).where(eq(s.store.slug, slug)).limit(1);
  if (!store) {
    [store] = await db.insert(s.store).values({
      slug,
      name,
      currency,
      // Stripe is the only shopper-capable public gateway in the launch shape.
      // It still fails closed until mode-matched keys are configured; test mode
      // is the payment layer's default until an operator explicitly flips live.
      config: {
        hostnames,
        payments: { stripe: true },
        stripe: { mode: 'test' },
      },
    }).returning({ id: s.store.id });
    console.log(`[bootstrap] created store ${slug} (${store!.id})`);
  } else {
    console.log(`[bootstrap] store ${slug} already exists; leaving settings unchanged`);
  }

  let [admin] = await db
    .select({ id: s.adminUser.id, passwordHash: s.adminUser.passwordHash })
    .from(s.adminUser)
    .where(eq(s.adminUser.email, email))
    .limit(1);

  if (!admin) {
    const passwordHash = await hashPassword(env.ADMIN_PASSWORD);
    [admin] = await db.insert(s.adminUser).values({ email, passwordHash }).returning({ id: s.adminUser.id, passwordHash: s.adminUser.passwordHash });
    console.log(`[bootstrap] created admin ${email} (${admin!.id})`);
  } else if (!admin.passwordHash) {
    const passwordHash = await hashPassword(env.ADMIN_PASSWORD);
    await db.update(s.adminUser).set({ passwordHash }).where(eq(s.adminUser.id, admin.id));
    console.log(`[bootstrap] initialized password for existing admin ${email}`);
  } else {
    console.log(`[bootstrap] admin ${email} already exists; password unchanged`);
  }

  await db
    .insert(s.adminUserStore)
    .values({ adminUserId: admin!.id, storeId: store!.id, role: 'owner' })
    .onConflictDoUpdate({
      target: [s.adminUserStore.adminUserId, s.adminUserStore.storeId],
      set: { role: 'owner' },
    });
  console.log(`[bootstrap] ensured ${email} is owner of ${slug}`);
}

main()
  .catch((error) => {
    console.error('[bootstrap] failed', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });
