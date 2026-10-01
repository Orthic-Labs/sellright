import { sql } from 'drizzle-orm';
import * as s from '../db/schema.js';

/** Guest email matching is a contact link, not proof of mailbox ownership. */
export function customerOwnsOrder(
  customer: { id: string; emailVerified: boolean } | null | undefined,
  order: { customerId: string | null; metadata: unknown },
): boolean {
  return !!customer && customer.id === order.customerId &&
    (customer.emailVerified || (order.metadata as { linked_via?: unknown } | null)?.linked_via !== 'email_match');
}

/** The same provenance check for account queries (including joined licenses). */
export function orderProvenanceFilter(customer: { emailVerified: boolean }) {
  return customer.emailVerified ? sql`true` : sql`(${s.order.metadata} ->> 'linked_via') IS DISTINCT FROM 'email_match'`;
}
