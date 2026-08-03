/**
 * Shared building blocks for the admin API surface (split across admin*.ts files
 * as it grows toward Shopify-parity). Auth/role guards, the error wrapper, and
 * common zod fragments live here so every admin route file uses one definition.
 */
import { z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { bearer } from '../auth/session.js';
import { cookie, SESSION_COOKIE } from '../auth/cookies.js';
import { resolveAdmin, type AdminPrincipal, type AdminStoreAccess } from '../auth/admin-session.js';

// Generic in the schema type so the concrete Zod type flows through to
// createRoute — @hono/zod-openapi v1 infers `c.req.valid('json')` from it;
// widening to z.ZodTypeAny (the old signature) collapses it to `unknown`.
export const J = <T extends z.ZodTypeAny>(schema: T) => ({ 'application/json': { schema } });
export const errBody = { content: J(z.object({ error: z.string() })) };

export type HttpStatus = 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429 | 502;
export class HttpError extends Error {
  constructor(public status: HttpStatus, message: string) {
    super(message);
  }
}

export type ReqCtx = { req: { header: (k: string) => string | undefined } };

export async function requireAdmin(c: ReqCtx): Promise<{ admin: AdminPrincipal; token: string }> {
  // httpOnly cookie session (browser) OR Authorization bearer (API clients).
  const token = bearer(c.req.header('authorization')) ?? cookie(c, SESSION_COOKIE);
  if (!token) throw new HttpError(401, 'not authenticated');
  const admin = await resolveAdmin(token);
  if (!admin) throw new HttpError(401, 'invalid or expired session');
  return { admin, token };
}

/** Resolve the selected store from x-store-slug and assert the admin can access it. */
export function requireStore(admin: AdminPrincipal, c: ReqCtx): AdminStoreAccess {
  const slug = c.req.header('x-store-slug') ?? admin.stores[0]?.slug;
  const st = admin.stores.find((x) => x.slug === slug);
  if (!st) throw new HttpError(403, `no access to store: ${slug ?? '(none)'}`);
  return st;
}

// Roles allowed to mutate. `read_only` may view but not change anything.
const WRITE_ROLES = new Set(['owner', 'manager', 'staff']);
export function requireWrite(st: AdminStoreAccess): void {
  if (!WRITE_ROLES.has(st.role)) throw new HttpError(403, `role '${st.role}' is read-only`);
}

// Roles allowed to manage other staff / store settings (tighter than write).
const ADMIN_ROLES = new Set(['owner', 'manager']);
export function requireManage(st: AdminStoreAccess): void {
  if (!ADMIN_ROLES.has(st.role)) throw new HttpError(403, `role '${st.role}' cannot manage settings/staff`);
}

// SEC-OWNER-1: owner-only gate. requireManage() intentionally admits 'manager'
// too, which is correct for ordinary staff administration but is NOT
// sufficient for anything that grants, holds, or removes the 'owner' role
// itself — otherwise a manager could self-elevate to owner or strip the real
// owner's access. Call this in addition to requireManage() for those cases.
export function requireOwner(st: AdminStoreAccess): void {
  if (st.role !== 'owner') throw new HttpError(403, `role '${st.role}' cannot manage owner-level access`);
}

/**
 * Per-action permission gate (composes with roles). owner/manager always pass.
 * Otherwise the action must be explicitly granted via the staff member's
 * `permissions` map — letting you give a `staff` user a single manage-class
 * capability (e.g. discounts or refunds) without making them a full manager.
 */
export function requirePermission(st: AdminStoreAccess, action: string): void {
  if (ADMIN_ROLES.has(st.role)) return;
  if (st.permissions?.[action] === true) return;
  throw new HttpError(403, `role '${st.role}' lacks the '${action}' permission`);
}

// Order states that count as revenue-bearing (paid lifecycle).
export const PAID_STATES = sql`array['Paid','PartiallyRefunded','Refunded']::order_state[]`;

// Generic so the happy-path return type (the typed c.json union) flows through to
// the OpenAPIHono handler; the error branch is cast into that same union.
export async function guard<T>(c: { json: (b: unknown, status?: number) => Response }, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HttpError) return c.json({ error: e.message }, e.status) as unknown as T;
    throw e;
  }
}

export const money = z.number().int();
export const Page = z.object({ items: z.array(z.unknown()), total: z.number().int(), page: z.number().int(), pageSize: z.number().int() });

/** URL-safe slug from a name (admin-created products/collections). */
export function slugify(input: string): string {
  return input.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'item';
}
