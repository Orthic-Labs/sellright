import { eq } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { normalizeEmail } from '../auth/email.js';

/**
 * The address customer-facing order mail goes to. Guest checkouts carry no
 * customerId, only the contact email captured at checkout in
 * order.metadata.contact.email, so that wins; a registered customer's account
 * email is the fallback. Shared by the paid-confirmation, refund and shipping
 * notification paths so they can never disagree about who an order belongs to.
 * Returns null when the order has no resolvable address.
 */
export async function resolveOrderRecipient(
  tx: Tx, order: { customerId: string | null; metadata?: unknown },
): Promise<string | null> {
  const contact = (order.metadata as { contact?: { email?: string } } | null | undefined)?.contact;
  const [customer] = order.customerId
    ? await tx.select({ email: s.customer.email }).from(s.customer).where(eq(s.customer.id, order.customerId)).limit(1) : [];
  return normalizeEmail(contact?.email || customer?.email || '') || null;
}
