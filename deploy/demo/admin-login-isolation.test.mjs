import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { demoAdminCredentials } from './interactive-policy.mjs';

// The published "Demo login: admin / admin" credential must only ever be
// honored by this demo wrapper (interactive-server.mjs intercepts POST
// /v1/admin/login before it reaches the real app — see the block guarded by
// demoAdminCredentials()). These tests prove the real sellright-api package
// has no way to accept it, independent of anything this demo does.

test('the demo credential function does not exist anywhere in the real api/admin packages', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const { execFileSync } = await import('node:child_process');
  let hit = '';
  try {
    // grep exits 1 (throws) when there are zero matches — that's the pass case.
    hit = execFileSync('grep', ['-rl', 'demoAdminCredentials', root + 'packages/api', root + 'packages/admin'], { encoding: 'utf8' });
  } catch { hit = ''; }
  assert.equal(hit.trim(), '', 'the demo-only credential bypass leaked into packages/api or packages/admin');
});

test('the real /v1/admin/login route requires a valid email format and a hashed-password match, never a literal comparison', async () => {
  const src = await readFile(fileURLToPath(new URL('../../packages/api/src/routes/admin.ts', import.meta.url)), 'utf8');
  const loginRoute = src.slice(src.indexOf("path: '/v1/admin/login'"));
  assert.match(loginRoute.slice(0, 800), /email:\s*z\.string\(\)\.email\(\)/, 'login body schema must require RFC email format (rejects the bare literal "admin")');
  assert.match(loginRoute, /verifyPassword\(password, u\.passwordHash\)/, 'login must verify against a stored password hash, not a literal string');
  assert.doesNotMatch(loginRoute, /['"]admin['"]\s*===\s*password|password\s*===\s*['"]admin['"]/, 'no literal "admin" password bypass may exist in the real route');
});

test("real app.request('/v1/admin/login', {admin, admin}) is rejected by schema validation before any database lookup — no live DB required for this to fail", async () => {
  const { createApp } = await import('../../packages/api/dist/app.js');
  const app = createApp();
  const res = await app.request('/v1/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin', password: 'admin' }),
  });
  // Zod's `.email()` rejects the bare literal "admin" (no @) at the request
  // schema layer — a 400, never the 200 the demo wrapper returns for the same
  // credentials on its own /v1/admin/login interception.
  assert.equal(res.status, 400);
  assert.notEqual(res.status, 200);
});

test('demoAdminCredentials accepts only the published literal, case-insensitive on email, and nothing else', () => {
  assert.equal(demoAdminCredentials({ email: 'admin', password: 'admin' }), true);
  assert.equal(demoAdminCredentials({ email: 'Admin', password: 'admin' }), true);
  assert.equal(demoAdminCredentials({ email: ' admin ', password: 'admin' }), true);
  for (const bad of [
    { email: 'admin', password: 'wrong' },
    { email: 'root', password: 'admin' },
    { email: 'admin@demo.invalid', password: 'admin' },
    { email: 'admin', password: 'Admin' },
    { password: 'admin' },
    { email: 'admin' },
    { email: 'admin', password: 'admin', totp: '000000' },
    {},
    null,
    undefined,
  ]) assert.equal(demoAdminCredentials(bad), false, JSON.stringify(bad));
});
