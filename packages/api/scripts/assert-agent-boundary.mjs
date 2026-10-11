#!/usr/bin/env node
// Agent deny-set invariants (docs/plans/2026-10-10-agent-role-v5.md):
//  (1) every AGENT_DENIED key is a registered non-wildcard /v1/admin route (a renamed route cannot silently leave the block);
//  (2) every registered DELETE /v1/admin route is in AGENT_DENIED;
//  (3) every registered mutation whose path matches IRREVERSIBLE_PATH is in AGENT_DENIED or AGENT_DENY_EXCEPTIONS.
// @hono/zod-openapi registers validator entries AND the terminal handler under the same method+path: dedupe with a Set.
import { buildHttpApp } from '../dist/app.js';
import { AGENT_DENIED, AGENT_DENY_EXCEPTIONS, IRREVERSIBLE_PATH } from '../dist/auth/agent-policy.js';
const app = buildHttpApp();
const real = new Set(app.routes.filter((r) => r.method !== 'ALL' && r.path.startsWith('/v1/admin/') && !r.path.includes('*')).map((r) => `${r.method} ${r.path}`));
const fail = [];
for (const k of AGENT_DENIED.keys()) if (!real.has(k)) fail.push(`not a registered route: ${k}`);
for (const k of real) {
  const [m, p] = k.split(' ');
  if (m === 'GET' || m === 'HEAD') continue;
  if (m === 'DELETE' && !AGENT_DENIED.has(k)) fail.push(`DELETE route missing from AGENT_DENIED: ${k}`);
  if (IRREVERSIBLE_PATH.test(p) && !AGENT_DENIED.has(k) && !AGENT_DENY_EXCEPTIONS.has(k)) fail.push(`irreversible-looking route neither denied nor excepted: ${k}`);
}
for (const k of AGENT_DENY_EXCEPTIONS) { if (!real.has(k)) fail.push(`exception is not a registered route: ${k}`); if (AGENT_DENIED.has(k)) fail.push(`route is both denied and excepted: ${k}`); }
// (4) self-test: the gate must notice the removal of any single denied entry that the regex covers.
for (const k of AGENT_DENIED.keys()) { const [m, p] = k.split(' '); if (m !== 'DELETE' && !IRREVERSIBLE_PATH.test(p)) fail.push(`denied route not covered by IRREVERSIBLE_PATH (its removal would go unnoticed): ${k}`); }
if (fail.length) { console.error('[agent-boundary] FAIL\n  ' + fail.join('\n  ')); process.exit(1); }
console.log(`[agent-boundary] ok (${AGENT_DENIED.size} denied of ${[...real].filter((k) => !k.startsWith('GET')).length} admin mutations; ${AGENT_DENY_EXCEPTIONS.size} exceptions)`);
