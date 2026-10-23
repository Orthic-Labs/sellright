/**
 * Sliding-window throttle for auth failures and high-risk shopper actions.
 * Storage is pluggable (SELLRIGHT-ISSUES P1) — see rate-limit-backend.ts:
 * RATE_LIMIT_BACKEND=postgres (default) shares this bucket's state across
 * every API process; RATE_LIMIT_BACKEND=memory is an explicit single-process
 * opt-out. Every function here is now async because of that — all existing
 * callers already run inside an async request handler, so this only meant
 * adding `await` at each call site, not restructuring them.
 *
 * Login/auth buckets remain failure-counted: callers explicitly record a failed
 * authentication and a successful login clears the key. Checkout/payment
 * buckets are attempt-counted because those routes do not have an equivalent
 * authentication-failure signal and every request is abuse-relevant.
 */
import { isIP } from 'node:net';
import { env } from '../env.js';
import { rateLimitBackend } from './rate-limit-backend.js';

const WINDOW_MS = 15 * 60 * 1000; // 15 min
const MAX_FAILURES = 8;
const BUCKET = 'auth';

function keyFor(ip: string, identifier: string): string {
  return `${ip}|${identifier.toLowerCase()}`;
}

/**
 * Consume one request from an attempt-counted bucket. Returns retry-after
 * seconds when the request must be rejected; otherwise records the attempt and
 * returns 0. Exactly MAX_FAILURES attempts are allowed in a window.
 */
export async function attemptRetryAfter(ip: string, identifier: string): Promise<number> {
  return rateLimitBackend().consume(BUCKET, keyFor(ip, identifier), WINDOW_MS, MAX_FAILURES);
}

// A separate checkout-only NAT-aware ceiling bounds session lookups before
// the finer per-customer/guest attempt budget. Never shares admin auth policy.
const CHECKOUT_IP_BUCKET = 'checkout-ip';
const CHECKOUT_IP_MAX_ATTEMPTS = 50;

/** Consume the tenant/IP checkout ceiling before resolving any session. */
export async function checkoutIpRetryAfter(ip: string, storeId: string): Promise<number> {
  return rateLimitBackend().consume(CHECKOUT_IP_BUCKET, keyFor(ip, storeId), WINDOW_MS, CHECKOUT_IP_MAX_ATTEMPTS);
}

/**
 * Throw-free check used by the existing auth call sites. Login/auth identifiers
 * are check-only and are incremented by recordLoginFailure(). Historical
 * checkout/pay call sites also use this function; recognize those explicit
 * namespaces and consume an attempt so their limiter cannot remain inert.
 */
export async function loginRetryAfter(ip: string, identifier: string): Promise<number> {
  if (identifier.startsWith('checkout:') || identifier.startsWith('pay:')) {
    return attemptRetryAfter(ip, identifier);
  }
  return rateLimitBackend().check(BUCKET, keyFor(ip, identifier), WINDOW_MS, MAX_FAILURES);
}

export async function recordLoginFailure(ip: string, identifier: string): Promise<void> {
  await rateLimitBackend().recordFailure(BUCKET, keyFor(ip, identifier), WINDOW_MS);
}

export async function clearLoginAttempts(ip: string, identifier: string): Promise<void> {
  await rateLimitBackend().clear(BUCKET, keyFor(ip, identifier));
}

// ── admin credential checks (P1a, security audit 2026-10-15) ─────────────────
// Every admin credential check — /v1/admin/login, /step-up, /2fa/enable,
// /2fa/disable, invite accept with a current password, password change — goes
// through ONE gate made of three buckets:
//   1. ip           — ADMIN_AUTH_IP_MAX_FAILURES (default 50) / 15 min across ALL accounts,
//                     so one address cannot spray passwords over many e-mails;
//   2. account      — ADMIN_AUTH_ACCOUNT_MAX_FAILURES (default 20) / 1 h across ALL IPs,
//                     so a botnet rotating addresses cannot grind one account;
//   3. (ip, account) — the original 8 / 15 min bucket.
// The attempt is RESERVED (atomically consumed, rate-limit-backend.ts) in all three
// BEFORE the credential is verified, so a concurrent burst cannot all pass the
// check while verification is in flight. A successful check clears (ip, account)
// and the account budget; the per-IP budget keeps the reservation (a shared NAT
// signing in many admins is still far below its cap). `account` is the
// normalized admin e-mail on every route, so the routes share one budget.
const ACCOUNT_BUCKET = 'admin-auth-account';
const IP_BUCKET = 'admin-auth-ip';
const ACCOUNT_WINDOW_MS = 60 * 60 * 1000;
const IP_WINDOW_MS = 15 * 60 * 1000;

const adminKey = (account: string) => `admin:${account.toLowerCase()}`;

/** Reserve one credential attempt. Returns seconds until the caller may try again (>0 = refuse, nothing verified);
 *  0 = the attempt is counted in all three budgets and verification may proceed. */
export async function reserveAdminAuthAttempt(ip: string, account: string): Promise<number> {
  const b = rateLimitBackend();
  const perIp = await b.consume(IP_BUCKET, ip, IP_WINDOW_MS, env.ADMIN_AUTH_IP_MAX_FAILURES);
  if (perIp > 0) return perIp;
  const acct = await b.consume(ACCOUNT_BUCKET, adminKey(account), ACCOUNT_WINDOW_MS, env.ADMIN_AUTH_ACCOUNT_MAX_FAILURES);
  if (acct > 0) return acct;
  return b.consume(BUCKET, keyFor(ip, adminKey(account)), WINDOW_MS, MAX_FAILURES);
}

/** Second sign-in step (issue #333): with a known account, the full three-bucket reservation; for a token that names
 *  no live challenge, only the per-IP budget (a dead token must not spend some account's budget). */
export async function reserveAdminSecondStepAttempt(ip: string, account: string | null): Promise<number> {
  if (account) return reserveAdminAuthAttempt(ip, account);
  return rateLimitBackend().consume(IP_BUCKET, ip, IP_WINDOW_MS, env.ADMIN_AUTH_IP_MAX_FAILURES);
}

/** Admin "forgot password" (issue #333): attempt-counted per IP and per account so it cannot be used to mail-bomb an
 *  admin or to probe addresses at speed. The account bucket is keyed by the submitted address whether or not it exists. */
const RESET_BUCKET = 'admin-reset';
export async function reserveAdminResetRequest(ip: string, account: string): Promise<number> {
  const b = rateLimitBackend();
  const perIp = await b.consume(RESET_BUCKET, `ip:${ip}`, IP_WINDOW_MS, 10);
  if (perIp > 0) return perIp;
  return b.consume(RESET_BUCKET, `acct:${account.toLowerCase()}`, ACCOUNT_WINDOW_MS, 3);
}

/** After a PASSWORD-verified success: forget the (ip, account) and account budgets. Never call it after a check that
 *  did not verify the password (a TOTP-only operation must not reset password-guessing budgets). */
export async function clearAdminAuthFailures(ip: string, account: string): Promise<void> {
  const b = rateLimitBackend();
  await Promise.all([b.clear(BUCKET, keyFor(ip, adminKey(account))), b.clear(ACCOUNT_BUCKET, adminKey(account))]);
}

/**
 * Pure decision logic for client-IP resolution, unit-testable without a Hono
 * context. Proxy-supplied headers are honoured ONLY when the TCP peer is a
 * proxy the deployment controls — a loopback / private / link-local address
 * (our own nginx/Caddy on the box or a Docker bridge) — or when there is no
 * socket at all (in-process `app.request`, e.g. tests and the demo shell).
 * A request whose peer is a public address reached the API directly, so any
 * `cf-connecting-ip` / `x-real-ip` it carries is client-forged: the socket
 * address is used instead (P1a, security audit 2026-10-15 — previously the
 * header was trusted from anyone and `remoteAddr` was never populated, so a
 * directly exposed API let each request pick its own rate-limit identity).
 *
 * `cf-connecting-ip` additionally requires `behindCloudflare` (SEC-5).
 * `trustedHeader` = '' disables header trust entirely. X-Forwarded-For is
 * INTENTIONALLY never read (trivially forgeable and multi-hop).
 */
export function pickClientIp(
  headers: { get: (k: string) => string | undefined },
  opts: { behindCloudflare: boolean; trustedHeader: string; remoteAddr?: string; trustedProxies?: readonly string[] },
): string {
  const peer = normalizePeer(opts.remoteAddr);
  const peerIsProxy = peer === undefined || (opts.trustedProxies?.length ? inCidrs(peer, opts.trustedProxies) : isLocalProxyAddress(peer));
  if (peerIsProxy) {
    if (opts.behindCloudflare) {
      const cf = headers.get('cf-connecting-ip');
      if (cf) return cf;
    }
    const h = opts.trustedHeader ? headers.get(opts.trustedHeader) : undefined;
    if (h) return h;
  }
  return peer ?? 'unknown';
}

/** Loopback, RFC 1918, CGNAT (100.64/10), link-local, IPv6 ::1 / ULA fc00::/7 / fe80::/10 —
 *  the only places a proxy the deployment controls can connect from. */
export function isLocalProxyAddress(addr: string): boolean {
  if (isIP(addr) === 4) {
    const [a, b] = addr.split('.').map(Number) as [number, number];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
  }
  const v6 = addr.toLowerCase();
  return v6 === '::1' || /^f[cd][0-9a-f]{2}:/.test(v6) || /^fe[89ab][0-9a-f]:/.test(v6);
}

/** Strict CIDR syntax: an IP, or an IP + '/' + a non-empty decimal prefix within the family width. null otherwise. */
export function parseCidr(raw: string): { net: string; len: number; family: 4 | 6 } | null {
  const m = /^([^/\s]+)(?:\/(\d{1,3}))?$/.exec(raw.trim());
  if (!m) return null;
  const family = isIP(m[1]!);
  if (family !== 4 && family !== 6) return null;
  const width = family === 4 ? 32 : 128;
  const len = m[2] === undefined ? width : Number(m[2]);
  if (!Number.isInteger(len) || len < 0 || len > width) return null;
  return { net: m[1]!, len, family };
}

/** Whether `addr` falls in any of `cidrs` (exact IP or CIDR, IPv4 / IPv6). Malformed entries never match. */
export function inCidrs(addr: string, cidrs: readonly string[]): boolean {
  const v = isIP(addr);
  if (!v) return false;
  const toBits = (ip: string, fam: number): bigint | null => {
    if (fam === 4) return ip.split('.').reduce((acc, o) => (acc << 8n) + BigInt(Number(o)), 0n);
    const [head, tail] = ip.toLowerCase().split('::');
    const h = head ? head.split(':') : [];
    const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
    const groups = tail !== undefined ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
    if (groups.length !== 8) return null;
    return groups.reduce((acc, g) => (acc << 16n) + BigInt(parseInt(g || '0', 16)), 0n);
  };
  const a = toBits(addr, v);
  if (a === null) return false;
  for (const raw of cidrs) {
    const parsed = parseCidr(raw);
    if (!parsed || parsed.family !== v) continue;
    const { net, len } = parsed;
    const width = v === 4 ? 32 : 128;
    const n = toBits(net, v);
    if (n === null) continue;
    const shift = BigInt(width - len);
    if ((a >> shift) === (n >> shift)) return true;
  }
  return false;
}

/** Strip the IPv4-mapped IPv6 prefix node reports for dual-stack sockets. */
function normalizePeer(addr: string | undefined): string | undefined {
  if (!addr) return undefined;
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  const out = v4 ? v4[1]! : addr;
  return isIP(out) ? out : undefined;
}

type ConnEnv = { remoteAddr?: string; incoming?: { socket?: { remoteAddress?: string } } };

/** Client IP for rate limiting / audit. `@hono/node-server` exposes the raw
 *  request as `c.env.incoming`; its socket address is the real TCP peer. */
export function clientIp(c: { req: { header: (k: string) => string | undefined }; env?: unknown }): string {
  const e = (c.env ?? undefined) as ConnEnv | undefined;
  return pickClientIp(
    { get: (k) => c.req.header(k) },
    {
      behindCloudflare: env.BEHIND_CLOUDFLARE === '1',
      trustedHeader: env.TRUSTED_PROXY_HEADER,
      remoteAddr: e?.incoming?.socket?.remoteAddress ?? e?.remoteAddr,
      trustedProxies: (env.TRUSTED_PROXY_CIDRS ?? '').split(',').map((x) => x.trim()).filter(Boolean),
    },
  );
}
