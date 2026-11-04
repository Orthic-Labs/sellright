/**
 * Saved admin accounts (#355, phase 2): the hub side, a broker that keeps sessions for other SellRight servers.
 *
 * A browser holds one hub session (sr_hub cookie, Path=/v1/hub; only its sha256 is stored). The admin enrols an account
 * on a configured target (HUB_TARGETS) with the phase 1 handoff: the hub starts an authorization-code + PKCE request,
 * the admin signs in on the TARGET (its own password, TOTP and passkeys), the target sends the browser back to
 * /v1/hub/callback/<target> with a one-use code, and the hub redeems it server to server for a bearer session. That
 * session is sealed in the vault (auth/hub-vault.ts) and never reaches the browser. Admin API calls for a saved account
 * go through the proxy, which adds the bearer and forwards only an allow-listed admin path on that target's origin.
 *
 * No request names a URL: destinations, client ids and secrets come from configuration only.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { unsafeUnscopedDb as db } from '../db/client.js';
import * as s from '../db/schema.js';
import { env } from '../env.js';
import { hubCallbackUri, parseHubOrigin, parseHubTargets, parseHubVaultKeys, type HubTarget, type HubVaultKey } from './hub-config.js';
import { open, seal, type Sealed } from './hub-vault.js';

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

export const HUB_COOKIE = 'sr_hub';
export const HUB_CSRF_COOKIE = 'sr_hub_csrf';
export const HUB_CSRF_HEADER = 'x-hub-csrf';
export const HUB_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const HUB_ENROL_TTL_MS = 10 * 60 * 1000;
/** Where the callback sends the browser afterwards (the hub admin's saved-accounts screen, phase 3). */
export const HUB_RETURN_PATH = '/admin/accounts';
const REDEEM_TIMEOUT_MS = 10_000;
const PROXY_TIMEOUT_MS = 20_000;
const REVOKE_TIMEOUT_MS = 5_000;
const TOKEN_BODY_CAP = 64 * 1024;
export const PROXY_BODY_CAP = 8 * 1024 * 1024;

export interface HubConfig { origin: string; targets: HubTarget[]; keys: HubVaultKey[] }

let cache: { raw: string; cfg: HubConfig | null } | undefined;
/** The hub is on only with HUB_ORIGIN, at least one target and at least one vault key. */
export function hubConfig(): HubConfig | null {
  const raw = JSON.stringify([env.HUB_ORIGIN, env.HUB_TARGETS, env.HUB_VAULT_KEYS]);
  if (cache?.raw === raw) return cache.cfg;
  const production = env.NODE_ENV === 'production';
  const targets = parseHubTargets(env.HUB_TARGETS, production), keys = parseHubVaultKeys(env.HUB_VAULT_KEYS);
  const cfg = env.HUB_ORIGIN && targets.length && keys.length ? { origin: parseHubOrigin(env.HUB_ORIGIN, production), targets, keys } : null;
  cache = { raw, cfg };
  return cfg;
}

/** Test seam: every outbound call to a target goes through this. */
let outbound: typeof fetch = (input, init) => fetch(input, init);
export function setHubFetchForTests(f: typeof fetch | null): void { outbound = f ?? ((input, init) => fetch(input, init)); }

function targetFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  return outbound(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
}

/** Reads at most `cap` bytes; null when the body is larger (the rest is cancelled). */
export async function readCapped(res: Response, cap: number): Promise<Uint8Array | null> {
  if (!res.body) return new Uint8Array();
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > cap) { await res.body.cancel().catch(() => {}); return null; }
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) { await reader.cancel().catch(() => {}); return null; }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}

// ── hub session ──────────────────────────────────────────────────────────────

export async function createHubSession(now = Date.now()): Promise<{ id: string; token: string }> {
  const token = randomBytes(32).toString('base64url');
  const [row] = await db.transaction(async (tx) => {
    await tx.delete(s.hubSession).where(lt(s.hubSession.expiresAt, sql`clock_timestamp()`));
    return tx.insert(s.hubSession).values({ tokenHash: sha256(token), expiresAt: new Date(now + HUB_SESSION_TTL_MS) }).returning({ id: s.hubSession.id });
  });
  return { id: row!.id, token };
}

export async function resolveHubSession(token: string | undefined): Promise<{ id: string } | null> {
  if (!token || token.length > 128) return null;
  const [row] = await db.update(s.hubSession).set({ lastSeenAt: sql`clock_timestamp()` })
    .where(and(eq(s.hubSession.tokenHash, sha256(token)), gt(s.hubSession.expiresAt, sql`clock_timestamp()`)))
    .returning({ id: s.hubSession.id });
  return row ?? null;
}

/** Double-submit check for hub mutations: header equals the CSRF cookie, constant time. */
export function hubCsrfValid(header: string | undefined, cooked: string | undefined): boolean {
  if (!header || !cooked) return false;
  const a = Buffer.from(header), b = Buffer.from(cooked);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── enrolment ────────────────────────────────────────────────────────────────

const enrolAad = (stateHash: string, hubSessionId: string, targetId: string) => `enrol|${stateHash}|${hubSessionId}|${targetId}`;
const slotAad = (slotId: string, hubSessionId: string, targetId: string) => `slot|${slotId}|${hubSessionId}|${targetId}`;

/** Starts an enrolment: the URL of the target's handoff page, or null for an unknown target. */
export async function startEnrolment(cfg: HubConfig, hubSessionId: string, targetId: string, now = Date.now()): Promise<string | null> {
  const target = cfg.targets.find((t) => t.id === targetId);
  if (!target) return null;
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  const stateHash = sha256(state);
  await db.transaction(async (tx) => {
    await tx.delete(s.hubEnrolment).where(lt(s.hubEnrolment.expiresAt, sql`clock_timestamp()`));
    await tx.insert(s.hubEnrolment).values({ stateHash, hubSessionId, targetId,
      verifierSealed: seal(cfg.keys, verifier, enrolAad(stateHash, hubSessionId, targetId)), expiresAt: new Date(now + HUB_ENROL_TTL_MS) });
  });
  const to = new URL('/admin/handoff', target.origin);
  to.searchParams.set('client_id', target.clientId);
  to.searchParams.set('redirect_uri', hubCallbackUri(cfg.origin, target.id));
  to.searchParams.set('state', state);
  to.searchParams.set('code_challenge', s256(verifier));
  to.searchParams.set('code_challenge_method', 'S256');
  return to.href;
}

const TokenReply = z.object({
  token: z.string().min(16).max(512), tokenType: z.literal('Bearer'), expiresInSeconds: z.number().int().positive(),
  admin: z.object({ id: z.string().min(1).max(64), email: z.string().min(1).max(320) }), issuer: z.string().max(512),
});

export type EnrolRefusal = 'unknown_target' | 'bad_request' | 'unknown_state' | 'issuer_mismatch' | 'redeem_failed';

/** The callback: spends the enrolment (whatever the outcome), redeems the code at the target and saves the account. */
export async function completeEnrolment(cfg: HubConfig, hubSessionId: string, targetId: string, q: { code?: string; state?: string; iss?: string }):
  Promise<{ ok: true; slotId: string } | { ok: false; reason: EnrolRefusal }> {
  const target = cfg.targets.find((t) => t.id === targetId);
  if (!target) return { ok: false, reason: 'unknown_target' };
  if (!q.code || !q.state || q.code.length > 128 || q.state.length > 256) return { ok: false, reason: 'bad_request' };
  const stateHash = sha256(q.state);
  const [row] = await db.delete(s.hubEnrolment)
    .where(and(eq(s.hubEnrolment.stateHash, stateHash), eq(s.hubEnrolment.hubSessionId, hubSessionId), eq(s.hubEnrolment.targetId, targetId),
      gt(s.hubEnrolment.expiresAt, sql`clock_timestamp()`)))
    .returning();
  if (!row) return { ok: false, reason: 'unknown_state' };
  // RFC 9207: the code must come from the server this enrolment was sent to (mix-up defence).
  if (q.iss !== target.origin) return { ok: false, reason: 'issuer_mismatch' };
  const verifier = open(cfg.keys, row.verifierSealed as Sealed, enrolAad(stateHash, hubSessionId, targetId));
  let reply: z.infer<typeof TokenReply>;
  try {
    const res = await targetFetch(`${target.origin}/v1/admin/handoff/token`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ grantType: 'authorization_code', clientId: target.clientId, clientSecret: target.clientSecret,
        redirectUri: hubCallbackUri(cfg.origin, target.id), code: q.code, codeVerifier: verifier }),
    }, REDEEM_TIMEOUT_MS);
    const body = res.status === 200 ? await readCapped(res, TOKEN_BODY_CAP) : (await res.body?.cancel().catch(() => {}), null);
    const parsed = body ? TokenReply.safeParse(JSON.parse(Buffer.from(body).toString('utf8'))) : null;
    if (!parsed?.success) return { ok: false, reason: 'redeem_failed' };
    reply = parsed.data;
  } catch {
    return { ok: false, reason: 'redeem_failed' };
  }
  if (reply.issuer !== target.origin) { await revokeTargetToken(target, reply.token); return { ok: false, reason: 'issuer_mismatch' }; }
  const expiresAt = new Date(Date.now() + reply.expiresInSeconds * 1000);
  const replaced = await db.transaction(async (tx) => {
    const [old] = await tx.select().from(s.hubAccountSlot)
      .where(and(eq(s.hubAccountSlot.hubSessionId, hubSessionId), eq(s.hubAccountSlot.targetId, target.id), eq(s.hubAccountSlot.adminId, reply.admin.id)))
      .for('update').limit(1);
    const slotId = old?.id ?? randomUUID();
    const tokenSealed = seal(cfg.keys, reply.token, slotAad(slotId, hubSessionId, target.id));
    if (old) await tx.update(s.hubAccountSlot).set({ tokenSealed, adminEmail: reply.admin.email, expiresAt }).where(eq(s.hubAccountSlot.id, slotId));
    else await tx.insert(s.hubAccountSlot).values({ id: slotId, hubSessionId, targetId: target.id, adminId: reply.admin.id, adminEmail: reply.admin.email, tokenSealed, expiresAt });
    return { slotId, old };
  });
  if (replaced.old) await revokeSlotToken(cfg, replaced.old);
  return { ok: true, slotId: replaced.slotId };
}

// ── saved accounts ───────────────────────────────────────────────────────────

type SlotRow = typeof s.hubAccountSlot.$inferSelect;

async function revokeTargetToken(target: HubTarget, token: string): Promise<void> {
  try {
    const res = await targetFetch(`${target.origin}/v1/admin/logout`, { method: 'POST', headers: { authorization: `Bearer ${token}` } }, REVOKE_TIMEOUT_MS);
    await res.body?.cancel().catch(() => {});
  } catch { /* best effort: the target session still expires on its own */ }
}

async function revokeSlotToken(cfg: HubConfig, slot: SlotRow): Promise<void> {
  const target = cfg.targets.find((t) => t.id === slot.targetId);
  if (!target) return;
  let token: string;
  try { token = open(cfg.keys, slot.tokenSealed as Sealed, slotAad(slot.id, slot.hubSessionId, slot.targetId)); } catch { return; }
  await revokeTargetToken(target, token);
}

export async function listSlots(cfg: HubConfig, hubSessionId: string) {
  const rows = await db.select().from(s.hubAccountSlot)
    .where(and(eq(s.hubAccountSlot.hubSessionId, hubSessionId), gt(s.hubAccountSlot.expiresAt, sql`clock_timestamp()`)));
  return rows.flatMap((r) => {
    const target = cfg.targets.find((t) => t.id === r.targetId);
    return target ? [{ id: r.id, targetId: r.targetId, targetLabel: target.label, adminEmail: r.adminEmail,
      expiresAt: r.expiresAt.toISOString(), lastUsedAt: r.lastUsedAt?.toISOString() ?? null }] : [];
  });
}

/** Forgets one saved account and signs its session out on the target. False when this hub session has no such slot. */
export async function removeSlot(cfg: HubConfig, hubSessionId: string, slotId: string): Promise<boolean> {
  const [row] = await db.delete(s.hubAccountSlot).where(and(eq(s.hubAccountSlot.id, slotId), eq(s.hubAccountSlot.hubSessionId, hubSessionId))).returning();
  if (!row) return false;
  await revokeSlotToken(cfg, row);
  return true;
}

/** Signs out of the hub: every saved account is revoked on its target, then the hub session ends. */
export async function endHubSession(cfg: HubConfig, hubSessionId: string): Promise<void> {
  const rows = await db.delete(s.hubAccountSlot).where(eq(s.hubAccountSlot.hubSessionId, hubSessionId)).returning();
  await db.delete(s.hubSession).where(eq(s.hubSession.id, hubSessionId));
  await Promise.all(rows.map((r) => revokeSlotToken(cfg, r)));
}

// ── proxy ────────────────────────────────────────────────────────────────────

export const PROXY_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const SEGMENT = /^[A-Za-z0-9._~-]{1,200}$/;
/** Credential and session management stay on the target's own screens: the hub never relays them. */
const DENIED = /^(handoff|login|logout|passkeys|password|2fa|step-up|api-tokens|staff\/accept)(\/|$)/i;

/** A relative admin API path (`orders/123`): plain segments only, no dot segments, no escapes, nothing denied. */
export function proxyPathAllowed(sub: string): boolean {
  if (!sub || sub.length > 1024) return false;
  const segs = sub.split('/');
  return segs.every((seg) => SEGMENT.test(seg) && seg !== '.' && seg !== '..') && !DENIED.test(sub);
}

export type ProxyResult =
  | { ok: true; status: number; contentType: string | null; body: Uint8Array }
  | { ok: false; reason: 'not_found' | 'reauth' | 'upstream' };

/** Relays one admin API call for a saved account. The browser never sees the bearer; responses carry no cookies. */
export async function proxyToTarget(cfg: HubConfig, hubSessionId: string, slotId: string,
  req: { method: string; subpath: string; search: string; contentType?: string; accept?: string; storeSlug?: string; idempotencyKey?: string; body?: ArrayBuffer }): Promise<ProxyResult> {
  const [slot] = await db.select().from(s.hubAccountSlot)
    .where(and(eq(s.hubAccountSlot.id, slotId), eq(s.hubAccountSlot.hubSessionId, hubSessionId), gt(s.hubAccountSlot.expiresAt, sql`clock_timestamp()`))).limit(1);
  const target = slot && cfg.targets.find((t) => t.id === slot.targetId);
  if (!slot || !target) return { ok: false, reason: 'not_found' };
  let token: string;
  try { token = open(cfg.keys, slot.tokenSealed as Sealed, slotAad(slot.id, slot.hubSessionId, slot.targetId)); } catch { return { ok: false, reason: 'reauth' }; }
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (req.contentType) headers['content-type'] = req.contentType;
  if (req.accept) headers.accept = req.accept;
  // Store selection and retry safety are part of the admin API contract; both are plain tokens, never credentials.
  if (req.storeSlug && /^[a-z0-9][a-z0-9-]{0,99}$/.test(req.storeSlug)) headers['x-store-slug'] = req.storeSlug;
  if (req.idempotencyKey && /^[A-Za-z0-9._:-]{1,200}$/.test(req.idempotencyKey)) headers['idempotency-key'] = req.idempotencyKey;
  let res: Response;
  try {
    res = await targetFetch(`${target.origin}/v1/admin/${req.subpath}${req.search}`, { method: req.method, headers,
      body: req.method === 'GET' ? undefined : req.body }, PROXY_TIMEOUT_MS);
  } catch {
    return { ok: false, reason: 'upstream' };
  }
  if (res.status >= 300 && res.status < 400) { await res.body?.cancel().catch(() => {}); return { ok: false, reason: 'upstream' }; }
  if (res.status === 401) {
    await res.body?.cancel().catch(() => {});
    // The target ended this session (sign-out, password reset, revocation): the saved account needs a new sign-in.
    await db.delete(s.hubAccountSlot).where(eq(s.hubAccountSlot.id, slot.id));
    return { ok: false, reason: 'reauth' };
  }
  const body = await readCapped(res, PROXY_BODY_CAP).catch(() => null);
  if (!body) return { ok: false, reason: 'upstream' };
  await db.update(s.hubAccountSlot).set({ lastUsedAt: sql`clock_timestamp()` }).where(eq(s.hubAccountSlot.id, slot.id));
  return { ok: true, status: res.status, contentType: res.headers.get('content-type'), body };
}
