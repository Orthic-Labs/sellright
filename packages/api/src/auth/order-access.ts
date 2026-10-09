import { sql } from 'drizzle-orm';
import * as s from '../db/schema.js';
import { normalizeEmail } from './email.js';

type MailboxOwner = { email: string; emailVerified: boolean };
/** Guest matching proves ownership only of the particular matched mailbox. */
export function customerOwnsOrder(
  customer: (MailboxOwner & { id: string }) | null | undefined,
  order: { customerId: string | null; metadata: unknown },
): boolean {
  if (!customer || customer.id !== order.customerId) return false;
  const metadata = order.metadata as { linked_via?: unknown; contact?: { email?: unknown } } | null;
  if (metadata?.linked_via !== 'email_match') return true;
  const email = metadata.contact?.email;
  return customer.emailVerified && typeof email === 'string' && email.trim() !== '' &&
    normalizeEmail(email) === normalizeEmail(customer.email);
}

/** Same proof for account queries and joined licenses/loyalty. */
export function orderProvenanceFilter(customer: MailboxOwner) {
  const provenMailbox = customer.emailVerified
    ? sql`lower(btrim(${s.order.metadata} -> 'contact' ->> 'email')) = ${normalizeEmail(customer.email)}`
    : sql`false`;
  return sql`((${s.order.metadata} ->> 'linked_via') IS DISTINCT FROM 'email_match' OR (${provenMailbox}))`;
}
