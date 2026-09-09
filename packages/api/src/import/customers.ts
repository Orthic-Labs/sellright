/** Atomic Vendure migration phase. Invoke through import/run.ts. */
import * as s from '../db/schema.js';
import { chunk, parseDate, parseJson, parseStrArray } from './store.js';

import { isLegacyBcryptHash } from '../auth/password.js';
import { normalizeEmail } from '../auth/email.js';
import type { ImportContext } from './context.js';

export async function importCustomers(ctx: ImportContext): Promise<void> {
  const { tx, q } = ctx;
  const customerMap = new Map<number, string>();

  {

    // --- customers ---
    const custRows = (
      await q(
        `SELECT c.id, c."emailAddress" AS email, c."firstName" AS fn, c."lastName" AS ln,
                c."phoneNumber" AS phone, c."customFieldsListmonksubscribedat" AS listmonk,
                c."customFieldsSheeridverifications" AS sheerid,
                c."customFieldsActiveverifications" AS active,
                c."customFieldsVerificationmetadata" AS vmeta, u.verified, am."passwordHash" AS password, c."createdAt" AS created, c."updatedAt" AS updated
         FROM customer c LEFT JOIN "user" u ON u.id = c."userId"
         LEFT JOIN authentication_method am ON am."userId"=c."userId" AND am.type='NativeAuthenticationMethod'
         WHERE c."deletedAt" IS NULL`,
      )
    ).map((c) => {
      const id = ctx.id('customer', c.id);
      if (c.password && !isLegacyBcryptHash(c.password)) throw new Error('Unsupported password hash for source customer ' + c.id);
      customerMap.set(c.id, id);
      return {
        id,
        storeId: ctx.storeId,
        email: normalizeEmail(c.email),
        passwordHash: c.password ?? null, createdAt: parseDate(c.created) ?? undefined, updatedAt: parseDate(c.updated) ?? undefined,
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
        `SELECT a.id, a."customerId" AS cid, a."fullName" AS fullname, a."streetLine1" AS l1,
                a."streetLine2" AS l2, a.city, a.province, a."postalCode" AS postal,
                a."phoneNumber" AS phone, a."defaultShippingAddress" AS dship,
                a."defaultBillingAddress" AS dbill, co.code AS country
         FROM address a LEFT JOIN region co ON co.id = a."countryId"`,
      )
    )
      .map((a) => {
        const customerId = customerMap.get(a.cid);
        if (!customerId) return null;
        if (!a.l1 || !a.city || !a.country) throw new Error('Missing required address fields: ' + a.id);
        return {
          id: ctx.id('address', a.id), storeId: ctx.storeId,
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
    console.log(JSON.stringify({ store: ctx.storeId, customers: custRows.length, addresses: addrRows.length }, null, 2));
  }

}
