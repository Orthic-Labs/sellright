/** Passkeys (0108): drop expired ceremony/grant rows an hour after expiry (design §6). Customer rows are RLS-forced,
 *  so the job walks the stores; admin rows are global. */
import { unsafeUnscopedDb as db } from '../db/client.js';
import * as s from '../db/schema.js';
import { pruneAdminPasskeyChallenges } from '../auth/passkeys-admin.js';
import { pruneCustomerPasskeyChallenges } from '../auth/passkeys-shop.js';
import { pruneAdminAuthChallenges } from '../auth/admin-auth-challenge.js';

export async function prunePasskeyChallenges(): Promise<{ admin: number; customer: number; adminAuth: number }> {
  const admin = await pruneAdminPasskeyChallenges();
  // Issue #333: expired sign-in step-2 / pending authenticator / reset tokens (admin_auth_challenge, global).
  const adminAuth = await pruneAdminAuthChallenges();
  let customer = 0;
  for (const st of await db.select({ id: s.store.id }).from(s.store)) customer += await pruneCustomerPasskeyChallenges(st.id);
  return { admin, customer, adminAuth };
}
