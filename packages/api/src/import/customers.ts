/**
 * Customer + address importer: Vendure (damned_vendure) -> SellRight.
 * Run AFTER catalog (shares DD_STORE_ID). Imports all non-deleted customers
 * (8.2k) + their addresses. No password hashes (Vendure auth lives in
 * authentication_method; auth migration is a separate concern) and no Stripe id
 * (DD is NMI/Sezzle). email_verified comes from the linked user.verified.
 *
 *   SOURCE_DATABASE_URL=...damned_vendure DATABASE_URL=...sellright_dev \
 *   corepack pnpm tsx src/import/customers.ts
 */
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { pool, withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { env } from '../env.js';
import { DD_STORE_ID, ensureDdStore, chunk, parseDate, parseJson, parseStrArray } from './store.js';

const SOURCE_URL = env.SOURCE_DATABASE_URL;
if (!SOURCE_URL) throw new Error('SOURCE_DATABASE_URL is required (the damned_vendure clone)');

// WP9.4: TRUNCATE guard (mirrors catalog.ts) — requires BOTH --force and
// ALLOW_FORCE_TRUNCATE=1 to override.
const TARGET_URL = env.DATABASE_URL;
const forceFlag = process.argv.includes('--force');
const forceEnv = env.ALLOW_FORCE_TRUNCATE === '1';
const allowedTarget = /[/_](dev|test)(\b|$|\?)/.test(TARGET_URL);
if (!allowedTarget && !(forceFlag && forceEnv)) {
  throw new Error(
    `REFUSING to TRUNCATE: DATABASE_URL does not look like a dev/test instance. ` +
    `Override requires BOTH --force and ALLOW_FORCE_TRUNCATE=1. url=${TARGET_URL.replace(/:[^:@/]+@/, ':***@')}`,
  );
}

const src = new Pool({ connectionString: SOURCE_URL });
const q = async (sql: string, params: unknown[] = []) => (await src.query(sql, params)).rows;

async function main() {
  // eslint-disable-next-line no-console
  console.log(`[import:customers] about to TRUNCATE address, customer. 5s to abort with Ctrl-C…`);
  await new Promise<void>((r) => setTimeout(r, 5_000));
  await pool.query(`TRUNCATE "address", "customer" CASCADE`);

  const customerMap = new Map<number, string>();

  await withStore(DD_STORE_ID, async (tx) => {
    await ensureDdStore(tx);

    // --- customers ---
    const custRows = (
      await q(
        `SELECT c.id, c."emailAddress" AS email, c."firstName" AS fn, c."lastName" AS ln,
                c."phoneNumber" AS phone, c."customFieldsListmonksubscribedat" AS listmonk,
                c."customFieldsSheeridverifications" AS sheerid,
                c."customFieldsActiveverifications" AS active,
                c."customFieldsVerificationmetadata" AS vmeta, u.verified
         FROM customer c LEFT JOIN "user" u ON u.id = c."userId"
         WHERE c."deletedAt" IS NULL`,
      )
    ).map((c) => {
      const id = randomUUID();
      customerMap.set(c.id, id);
      return {
        id,
        storeId: DD_STORE_ID,
        email: c.email,
        firstName: c.fn ?? null,
        lastName: c.ln ?? null,
        phone: c.phone ?? null,
        listmonkSubscribedAt: parseDate(c.listmonk),
        emailVerified: c.verified ?? false,
        sheeridVerifications: parseJson(c.sheerid),
        activeVerifications: parseStrArray(c.active),
        verificationMetadata: parseJson(c.vmeta),
      };
    });
    for (const part of chunk(custRows, 500)) await tx.insert(s.customer).values(part);

    // --- addresses (country code via country table; no soft-delete on address) ---
    const addrRows = (
      await q(
        `SELECT a."customerId" AS cid, a."fullName" AS fullname, a."streetLine1" AS l1,
                a."streetLine2" AS l2, a.city, a.province, a."postalCode" AS postal,
                a."phoneNumber" AS phone, a."defaultShippingAddress" AS dship,
                a."defaultBillingAddress" AS dbill, co.code AS country
         FROM address a LEFT JOIN region co ON co.id = a."countryId"`,
      )
    )
      .map((a) => {
        const customerId = customerMap.get(a.cid);
        if (!customerId) return null;
        return {
          storeId: DD_STORE_ID,
          customerId,
          fullName: a.fullname ?? null,
          line1: a.l1 ?? null,
          line2: a.l2 ?? null,
          city: a.city ?? null,
          province: a.province ?? null,
          postalCode: a.postal ?? null,
          country: a.country ?? null,
          phone: a.phone ?? null,
          isDefaultShipping: a.dship ?? false,
          isDefaultBilling: a.dbill ?? false,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    for (const part of chunk(addrRows, 500)) await tx.insert(s.address).values(part);

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ store: DD_STORE_ID, customers: custRows.length, addresses: addrRows.length }, null, 2));
  });

  await src.end();
  await pool.end();
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await src.end(); } catch { /* noop */ }
    try { await pool.end(); } catch { /* noop */ }
  });
