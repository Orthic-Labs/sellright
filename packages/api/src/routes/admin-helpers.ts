/**
 * Shared building blocks for the admin API surface (split across admin*.ts files
 * as it grows toward Shopify-parity). Auth/role guards, the error wrapper, and
 * common zod fragments live here so every admin route file uses one definition.
 */
import { z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { bearer } from '../auth/session.js';
import { cookie, SESSION_COOKIE } from '../auth/cookies.js';
import { resolveAdmin, type AdminPrincipal, type AdminStoreAccess } from '../auth/admin-session.js';
import { apiErrorSchema, errorEnvelope, slugifyCode, type HttpStatus } from '../lib/api-error.js';

// Generic in the schema type so the concrete Zod type flows through to
// createRoute — @hono/zod-openapi v1 infers `c.req.valid('json')` from it;
// widening to z.ZodTypeAny (the old signature) collapses it to `unknown`.
export const J = <T extends z.ZodTypeAny>(schema: T) => ({ 'application/json': { schema } });
// SR-CLIENT-1: the structured envelope (lib/api-error.ts), not a bare
// `{ error: string }` — every route using `errBody` for its OpenAPI response
// docs is documenting (and, via HttpError + app.ts's onError, actually
// returning) `{ error: { code, message, param?, requestId? } }`.
export const errBody = { content: J(apiErrorSchema()) };

export type { HttpStatus };
/** Central admin-surface error type, thrown and formatted once by app.ts's
 *  `onError`. `code` is optional at the throw site — when omitted it's
 *  derived from `message` (see `slugifyCode`), so all pre-existing
 *  `new HttpError(status, message)` call sites keep compiling and now emit
 *  the structured envelope for free. `extra` lets a throw site attach
 *  sibling fields (alongside `error`, never inside it) the way the old
 *  inline `c.json({ error, ...extra }, status)` calls did. */
export class HttpError extends Error {
  public readonly code: string;
  constructor(
    public status: HttpStatus,
    message: string,
    code?: string,
    public param?: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
    this.code = code ?? slugifyCode(message);
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

// One-click install (plan §1.3): system operations (backup/restore trigger,
// recovery-kit download, add-store, future update trigger) require the
// install-wide `isInstallationAdmin` flag. Holding 'owner' on some store —
// even every store — never satisfies this on its own; owning store B must
// never grant system operations over store A or the install itself.
export function requireInstallationAdmin(admin: AdminPrincipal): void {
  if (!admin.isInstallationAdmin) {
    throw new HttpError(403, 'requires installation administrator');
  }
}

// 5-minute step-up window, matching common re-auth conventions (GitHub's
// sudo mode, AWS's re-auth for sensitive IAM actions). Deliberately short and
// per-session (session.step_up_at, not admin_user) — stepping up in one
// browser tab must never grant it to another session of the same admin, and
// a stale step-up from an hour ago must not silently authorize a fresh
// download.
const STEP_UP_WINDOW_MS = 5 * 60 * 1000;

/** Thrown by a step-up-gated route with no (or an expired) step-up on file
 *  for THIS session. The admin UI matches this exact message to decide
 *  whether to show the step-up prompt versus a generic error. */
export const STEP_UP_REQUIRED_MESSAGE = 'step_up_required';

/** Recovery-kit download (and any future sensitive system action) requires
 *  the CURRENT session to have re-verified the admin's password (+ TOTP if
 *  enabled) within the last 5 minutes — see POST /v1/admin/step-up. Being an
 *  installation administrator is necessary but not sufficient: a stolen or
 *  long-lived session cookie alone must not be able to exfiltrate the master
 *  key without the admin re-proving their password at the moment of use. */
export function requireStepUp(admin: AdminPrincipal): void {
  if (!admin.stepUpAt || Date.now() - admin.stepUpAt.getTime() > STEP_UP_WINDOW_MS) {
    throw new HttpError(403, STEP_UP_REQUIRED_MESSAGE);
  }
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
export async function guard<T>(c: Context, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HttpError) {
      return c.json(errorEnvelope(c, e.code, e.message, { param: e.param, extra: e.extra }), e.status) as unknown as T;
    }
    throw e;
  }
}

export const money = z.number().int();
export const Page = z.object({ items: z.array(z.unknown()), total: z.number().int(), page: z.number().int(), pageSize: z.number().int() });

/** URL-safe slug from a name (admin-created products/collections). */
export { slugify } from '../lib/slug.js';
