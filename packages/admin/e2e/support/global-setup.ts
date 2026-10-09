import { mkdirSync } from 'node:fs';
import { request } from '@playwright/test';
import { AdminApi } from './api';
import { seedBaseline } from './seed';
import { ADMIN_URL, AUTH_FILE, OWNER_EMAIL, OWNER_PASSWORD, RUN_DIR } from './env.mjs';

/**
 * Runs once per `playwright test` after both webServers are up (the API has just been rebuilt from a
 * fresh database by start-api.mjs): seed the baseline over the admin API, then sign the owner in
 * *through the admin origin's /v1 proxy* so the cookies a real browser would hold are stored once and
 * reused by every spec (httpOnly session + CSRF cookie).
 */
export default async function globalSetup() {
  mkdirSync(RUN_DIR, { recursive: true });
  const api = await AdminApi.login();
  await seedBaseline(api);

  const ctx = await request.newContext({ baseURL: ADMIN_URL });
  const res = await ctx.post('/v1/admin/login', { data: { email: OWNER_EMAIL, password: OWNER_PASSWORD } });
  if (!res.ok()) throw new Error(`owner login through the admin proxy failed: ${res.status()} ${await res.text()}`);
  await ctx.storageState({ path: AUTH_FILE });
  await ctx.dispose();
}
