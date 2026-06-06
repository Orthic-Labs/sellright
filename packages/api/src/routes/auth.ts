import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { withStore, db } from '../db/client.js';
import { resolveStore, DEV_DEFAULT_STORE, type StoreCtx } from '../store-context.js';
import * as s from '../db/schema.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { customerToken, createSession, deleteSession, resolveCustomer } from '../auth/session.js';
import { setCustomerCookies, clearCustomerCookies, customerCsrfValid, newCsrf } from '../auth/cookies.js';
import { clientIp, loginRetryAfter, recordLoginFailure, clearLoginAttempts } from '../auth/rate-limit.js';
import { normalizeEmail } from '../auth/email.js';

async function store(c: { req: { header: (k: string) => string | undefined } }): Promise<StoreCtx> {
  const slug = c.req.header('x-store-slug') ?? DEV_DEFAULT_STORE;
  const found = await resolveStore(slug);
  if (!found) throw new Error(`unknown store: ${slug}`);
  return found;
}

/** The store's Google OAuth client id (store config or env GOOGLE_CLIENT_ID). */
async function googleClientId(storeId: string): Promise<string | null> {
  const [row] = await db.select({ config: s.store.config }).from(s.store).where(eq(s.store.id, storeId)).limit(1);
  return (row?.config as { googleClientId?: string } | null)?.googleClientId ?? process.env.GOOGLE_CLIENT_ID ?? null;
}

/** Verify a Google Identity Services ID token via Google's tokeninfo endpoint —
 *  validates signature + expiry server-side; we additionally check `aud`. */
async function verifyGoogleIdToken(credential: string, clientId: string): Promise<{ sub: string; email: string; emailVerified: boolean; firstName: string | null; lastName: string | null } | null> {
  const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
  if (!res.ok) return null;
  const p = (await res.json()) as { aud?: string; sub?: string; email?: string; email_verified?: string | boolean; given_name?: string; family_name?: string };
  if (!p.sub || !p.email || p.aud !== clientId) return null;
  const emailVerified = p.email_verified === true || p.email_verified === 'true';
  return { sub: p.sub, email: normalizeEmail(p.email), emailVerified, firstName: p.given_name ?? null, lastName: p.family_name ?? null };
}

const CustomerOut = z.object({ email: z.string(), firstName: z.string().nullable(), lastName: z.string().nullable(), emailVerified: z.boolean() });

export const auth = new OpenAPIHono();

// POST /v1/shop/auth/register
auth.openapi(
  createRoute({
    method: 'post',
    path: '/v1/shop/auth/register',
    summary: 'Register a customer account',
    request: { body: { content: { 'application/json': { schema: z.object({ email: z.string().email(), password: z.string().min(8), firstName: z.string().optional(), lastName: z.string().optional() }) } } } },
    responses: {
      200: { description: 'Registered', content: { 'application/json': { schema: z.object({ token: z.string(), customer: CustomerOut }) } } },
      409: { description: 'Email taken', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
    },
  }),
  async (c) => {
    const st = await store(c);
    const { email: rawEmail, password, firstName, lastName } = c.req.valid('json');
    const email = normalizeEmail(rawEmail);
    const passwordHash = await hashPassword(password);
    const out = await withStore(st.id, async (tx): Promise<{ taken: true } | { token: string; firstName: string | null; lastName: string | null }> => {
      const existing = await tx.select({ id: s.customer.id }).from(s.customer).where(eq(s.customer.email, email)).limit(1);
      if (existing.length) return { taken: true };
      const [cust] = await tx.insert(s.customer).values({ storeId: st.id, email, firstName: firstName ?? null, lastName: lastName ?? null, passwordHash, emailVerified: false }).returning({ id: s.customer.id, firstName: s.customer.firstName, lastName: s.customer.lastName });
      const token = await createSession(tx, st.id, cust!.id);
      return { token, firstName: cust!.firstName, lastName: cust!.lastName };
    });
    if ('taken' in out) return c.json({ error: 'email already registered' }, 409);
    setCustomerCookies(c, out.token, newCsrf());
    return c.json({ token: out.token, customer: { email, firstName: out.firstName, lastName: out.lastName, emailVerified: false } }, 200);
  },
);

// POST /v1/shop/auth/login
auth.openapi(
  createRoute({
    method: 'post',
    path: '/v1/shop/auth/login',
    summary: 'Log in',
    request: { body: { content: { 'application/json': { schema: z.object({ email: z.string().email(), password: z.string() }) } } } },
    responses: {
      200: { description: 'OK', content: { 'application/json': { schema: z.object({ token: z.string(), customer: CustomerOut }) } } },
      401: { description: 'Invalid', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
      429: { description: 'Too many attempts', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
    },
  }),
  async (c) => {
    const st = await store(c);
    const { email: rawEmail, password } = c.req.valid('json');
    const email = normalizeEmail(rawEmail);
    const ip = clientIp(c);
    const retry = loginRetryAfter(ip, email);
    if (retry > 0) return c.json({ error: `too many attempts — try again in ${retry}s` }, 429);
    const out = await withStore(st.id, async (tx): Promise<{ ok: false } | { ok: true; token: string; customer: z.infer<typeof CustomerOut> }> => {
      const [cust] = await tx.select().from(s.customer).where(eq(s.customer.email, email)).limit(1);
      if (!cust || !(await verifyPassword(password, cust.passwordHash))) return { ok: false };
      const token = await createSession(tx, st.id, cust.id);
      return { ok: true, token, customer: { email: cust.email, firstName: cust.firstName, lastName: cust.lastName, emailVerified: cust.emailVerified } };
    });
    if (!out.ok) { recordLoginFailure(ip, email); return c.json({ error: 'invalid email or password' }, 401); }
    clearLoginAttempts(ip, email);
    setCustomerCookies(c, out.token, newCsrf());
    return c.json({ token: out.token, customer: out.customer }, 200);
  },
);

// POST /v1/shop/auth/google — sign in / up with a Google ID token (GIS credential)
auth.openapi(
  createRoute({
    method: 'post',
    path: '/v1/shop/auth/google',
    summary: 'Sign in with Google',
    request: { body: { content: { 'application/json': { schema: z.object({ credential: z.string().min(20) }) } } } },
    responses: {
      200: { description: 'OK', content: { 'application/json': { schema: z.object({ token: z.string(), customer: CustomerOut }) } } },
      401: { description: 'Invalid token', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
      409: { description: 'Not configured', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
    },
  }),
  async (c) => {
    const st = await store(c);
    const clientId = await googleClientId(st.id);
    if (!clientId) return c.json({ error: 'Google sign-in is not configured for this store' }, 409);
    const { credential } = c.req.valid('json');
    const g = await verifyGoogleIdToken(credential, clientId);
    if (!g || !g.emailVerified) return c.json({ error: 'invalid or unverified Google token' }, 401);
    const out = await withStore(st.id, async (tx): Promise<{ token: string; customer: z.infer<typeof CustomerOut> }> => {
      // Match by googleSub first, then link by email, else create.
      let [cust] = await tx.select().from(s.customer).where(eq(s.customer.googleSub, g.sub)).limit(1);
      if (!cust) {
        const [byEmail] = await tx.select().from(s.customer).where(eq(s.customer.email, g.email)).limit(1);
        if (byEmail) {
          await tx.update(s.customer).set({ googleSub: g.sub, emailVerified: true, updatedAt: new Date() }).where(eq(s.customer.id, byEmail.id));
          cust = byEmail;
        } else {
          const [created] = await tx.insert(s.customer).values({ storeId: st.id, email: g.email, firstName: g.firstName, lastName: g.lastName, googleSub: g.sub, emailVerified: true }).returning();
          cust = created!;
        }
      }
      const token = await createSession(tx, st.id, cust.id);
      return { token, customer: { email: cust.email, firstName: cust.firstName, lastName: cust.lastName, emailVerified: true } };
    });
    setCustomerCookies(c, out.token, newCsrf());
    return c.json(out, 200);
  },
);

// GET /v1/shop/auth/me
auth.openapi(
  createRoute({
    method: 'get',
    path: '/v1/shop/auth/me',
    summary: 'Current customer',
    responses: {
      200: { description: 'OK', content: { 'application/json': { schema: CustomerOut } } },
      401: { description: 'Unauthenticated', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
    },
  }),
  async (c) => {
    const st = await store(c);
    const token = customerToken(c);
    if (!token) return c.json({ error: 'not authenticated' }, 401);
    const cust = await withStore(st.id, (tx) => resolveCustomer(tx, token));
    if (!cust) return c.json({ error: 'not authenticated' }, 401);
    return c.json({ email: cust.email, firstName: cust.firstName, lastName: cust.lastName, emailVerified: cust.emailVerified }, 200);
  },
);

// POST /v1/shop/auth/logout
auth.openapi(
  createRoute({
    method: 'post',
    path: '/v1/shop/auth/logout',
    summary: 'Log out',
    responses: { 200: { description: 'OK', content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } } }, 403: { description: 'CSRF', content: { 'application/json': { schema: z.object({ error: z.string() }) } } } },
  }),
  async (c) => {
    const st = await store(c);
    if (!customerCsrfValid(c)) return c.json({ error: 'invalid CSRF token' }, 403);
    const token = customerToken(c);
    if (token) await withStore(st.id, (tx) => deleteSession(tx, token));
    clearCustomerCookies(c);
    return c.json({ ok: true }, 200);
  },
);
