/**
 * Create (or rotate) an agent seat for one store and print its API token ONCE to stdout.
 * Usage: node dist/scripts/agent-token.js <store-slug> <name> [staff|manager|read_only]
 * Shares the transactional lifecycle with the admin route. Messages go to stderr so `TOKEN=$(node …)` captures only the token.
 */
import { and, eq } from 'drizzle-orm';
import { unsafeUnscopedDb as db, pool, withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { createAgentSeat, rotateAgentSeat, type AgentRole } from '../auth/agent-lifecycle.js';

async function main() {
  const [slug, name, roleArg] = [process.argv[2], process.argv[3], process.argv[4] ?? 'staff'];
  if (!slug || !name || !['staff', 'manager', 'read_only'].includes(roleArg)) { console.error('usage: node dist/scripts/agent-token.js <store-slug> <name> [staff|manager|read_only]'); process.exit(1); }
  const [st] = await db.select({ id: s.store.id }).from(s.store).where(eq(s.store.slug, slug)).limit(1);
  if (!st) { console.error(`[agent-token] no store with slug ${slug}`); process.exit(2); }
  const existing = await withStore(st.id, (tx) => tx.select({ id: s.adminUser.id }).from(s.adminUser)
    .innerJoin(s.adminUserStore, and(eq(s.adminUserStore.adminUserId, s.adminUser.id), eq(s.adminUserStore.storeId, st.id)))
    .where(and(eq(s.adminUser.kind, 'agent'), eq(s.adminUser.name, `Agent: ${name}`))).limit(1));
  const actor = 'agent-token script';
  const token = existing[0]
    ? (await rotateAgentSeat({ storeId: st.id, adminUserId: existing[0].id, actor })).token
    : (await createAgentSeat({ storeId: st.id, storeSlug: slug, name, role: roleArg as AgentRole, actor, expiresAt: null })).token;
  console.error(`[agent-token] ${existing[0] ? 'rotated' : 'created'} "${name}" on ${slug}${existing[0] ? '' : ` as ${roleArg}`}`);
  process.stdout.write(token + '\n');
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
