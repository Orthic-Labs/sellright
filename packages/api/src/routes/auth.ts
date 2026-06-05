import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import { resolveStore, DEV_DEFAULT_STORE, type StoreCtx } from '../store-context.js';
import * as s from '../db/schema.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { bearer, createSession, deleteSession, resolveCustomer } from '../auth/session.js';

async function store(c: { req: { header: (k: string) => string | undefined } }): Promise<StoreCtx> {
  const slug = c.req.header('x-store-slug') ?? DEV_DEFAULT_STORE;
  const found = await resolveStore(slug);
  if (!found) throw new Error(`unknown store: ${slug}`);
  return found;
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
    const { email, password, firstName, lastName } = c.req.valid('json');
    const passwordHash = await hashPassword(password);
    const out = await withStore(st.id, async (tx): Promise<{ taken: true } | { token: string; firstName: string | null; lastName: string | null }> => {
      const existing = await tx.select({ id: s.customer.id }).from(s.customer).where(eq(s.customer.email, email)).limit(1);
      if (existing.length) return { taken: true };
      const [cust] = await tx.insert(s.customer).values({ storeId: st.id, email, firstName: firstName ?? null, lastName: lastName ?? null, passwordHash, emailVerified: false }).returning({ id: s.customer.id, firstName: s.customer.firstName, lastName: s.customer.lastName });
      const token = await createSession(tx, st.id, cust!.id);
      return { token, firstName: cust!.firstName, lastName: cust!.lastName };
    });
    if ('taken' in out) return c.json({ error: 'email already registered' }, 409);
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
    },
  }),
  async (c) => {
    const st = await store(c);
    const { email, password } = c.req.valid('json');
    const out = await withStore(st.id, async (tx): Promise<{ ok: false } | { ok: true; token: string; customer: z.infer<typeof CustomerOut> }> => {
      const [cust] = await tx.select().from(s.customer).where(eq(s.customer.email, email)).limit(1);
      if (!cust || !(await verifyPassword(password, cust.passwordHash))) return { ok: false };
      const token = await createSession(tx, st.id, cust.id);
      return { ok: true, token, customer: { email: cust.email, firstName: cust.firstName, lastName: cust.lastName, emailVerified: cust.emailVerified } };
    });
    if (!out.ok) return c.json({ error: 'invalid email or password' }, 401);
    return c.json({ token: out.token, customer: out.customer }, 200);
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
    const token = bearer(c.req.header('authorization'));
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
    responses: { 200: { description: 'OK', content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } } } },
  }),
  async (c) => {
    const st = await store(c);
    const token = bearer(c.req.header('authorization'));
    if (token) await withStore(st.id, (tx) => deleteSession(tx, token));
    return c.json({ ok: true }, 200);
  },
);
