/**
 * Who an order belongs to, for admin display (#374). A guest checkout has no linked customer, but the order itself
 * carries the contact captured at checkout: `metadata.contact.email`, and the name/phone on the shipping (else
 * billing) address. The linked customer wins when there is one; the order's own contact fills whatever is missing.
 * The SQL forms serve list/search/export/dashboard; `orderContact` serves an order row already in memory.
 */
import { sql, type SQL } from 'drizzle-orm';

/** The customer table as the query names it: `customer` (drizzle leftJoin) or an alias such as `cust`. */
export function orderContactSql(customer: 'customer' | 'cust') {
  const c = sql.raw(`"${customer}"`);
  return {
    email: sql<string | null>`coalesce(nullif(${c}.email, ''), nullif("order".metadata->'contact'->>'email', ''))`,
    name: sql<string | null>`coalesce(nullif(trim(concat_ws(' ', ${c}.first_name, ${c}.last_name)), ''),
      nullif(trim("order".shipping_address->>'fullName'), ''), nullif(trim("order".billing_address->>'fullName'), ''))`,
    phone: sql<string | null>`coalesce(nullif(${c}.phone, ''), nullif("order".shipping_address->>'phone', ''), nullif("order".billing_address->>'phone', ''))`,
  };
}

/** Order search: code, then the resolved email, name and phone (so a guest order is found by its own contact). */
export function orderSearchSql(q: string, customer: 'customer' | 'cust'): SQL {
  const like = `%${q}%`;
  const { email, name, phone } = orderContactSql(customer);
  return sql`("order".code ilike ${like} or ${email} ilike ${like} or ${name} ilike ${like} or ${phone} ilike ${like})`;
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** The order's own contact (no customer lookup): metadata.contact.email + shipping, else billing, name/phone. */
export function orderContact(o: { metadata?: unknown; shippingAddress?: unknown; billingAddress?: unknown }): { name: string | null; email: string | null; phone: string | null } {
  const contact = (o.metadata as { contact?: { email?: unknown } } | null | undefined)?.contact;
  const ship = (o.shippingAddress ?? {}) as Record<string, unknown>;
  const bill = (o.billingAddress ?? {}) as Record<string, unknown>;
  return {
    name: text(ship.fullName) ?? text(bill.fullName),
    email: text(contact?.email),
    phone: text(ship.phone) ?? text(bill.phone),
  };
}
