/** Optimistic blog writes and durable create receipts within the existing store transaction. */
import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { HttpError } from './admin-helpers.js';

type StoreTx = Parameters<Parameters<typeof withStore>[1]>[0];
export const BLOG_CONTRACT = 'revision-v1';
export const CREATE_CONTRACT = 'audit-receipt-v1';

function stable(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]));
  }
  return value;
}

export function blogRevision(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function receiptId(storeId: string, key: string): string {
  const h = createHash('sha256').update(`sellright:blog-create:v1\0${storeId}\0${key}`).digest('hex');
  // UUIDv8 custom, namespaced by store and operation. Never a bearer credential.
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function createKey(header: string | undefined): string | undefined {
  if (header !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(header)) {
    throw new HttpError(400, 'invalid idempotency key');
  }
  return header;
}

/** Lock before checking the revision, in the SAME transaction as the later UPDATE. */
export async function lockedBlog(tx: StoreTx, storeId: string, id: string, expectedRevision?: string) {
  await tx.execute(sql`SELECT id FROM blog_post WHERE store_id = ${storeId} AND id = ${id} FOR UPDATE`);
  const [post] = await tx.select().from(s.blogPost).where(eq(s.blogPost.id, id)).limit(1);
  if (!post || post.storeId !== storeId) throw new HttpError(404, 'post not found');
  if (expectedRevision !== undefined && expectedRevision !== blogRevision(post)) {
    throw new HttpError(409, 'blog revision conflict; read and review the current post');
  }
  return post;
}

/** A UUID foreign key alone does not establish that the asset belongs to this store. */
export async function ownedFeaturedAsset(tx: StoreTx, storeId: string, id: string | null | undefined): Promise<void> {
  if (id == null) return;
  await tx.execute(sql`SELECT id FROM asset WHERE store_id = ${storeId} AND id = ${id} FOR KEY SHARE`);
  const [asset] = await tx.select({ id: s.asset.id, storeId: s.asset.storeId }).from(s.asset).where(eq(s.asset.id, id)).limit(1);
  if (!asset || asset.storeId !== storeId) throw new HttpError(404, 'featured asset not found in this store');
}

/** Existing audit_log is the durable effect journal. Retain these namespace records. */
export async function existingCreate(tx: StoreTx, storeId: string, key: string | undefined, request: unknown) {
  if (key === undefined) return { receiptId: undefined, requestHash: undefined, result: undefined };
  const id = receiptId(storeId, key);
  const lock = BigInt.asIntN(64, BigInt(`0x${id.replaceAll('-', '').slice(0, 16)}`)).toString();
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${lock}::bigint)`);
  const hash = blogRevision(request);
  const [receipt] = await tx.select().from(s.auditLog).where(eq(s.auditLog.id, id)).limit(1);
  if (!receipt) return { receiptId: id, requestHash: hash, result: undefined };
  const data = receipt.data as { requestHash?: string; postId?: string; slug?: string } | null;
  if (receipt.storeId !== storeId || receipt.entity !== 'blog_post' || receipt.action !== 'idempotent_create' ||
      !data || data.requestHash !== hash || typeof data.postId !== 'string' || typeof data.slug !== 'string') {
    throw new HttpError(409, 'idempotency key belongs to a different create request');
  }
  const [post] = await tx.select({ id: s.blogPost.id }).from(s.blogPost).where(eq(s.blogPost.id, data.postId)).limit(1);
  if (!post) throw new HttpError(409, 'the recorded post was deleted; this key will not recreate it');
  return { receiptId: id, requestHash: hash, result: { id: data.postId, slug: data.slug } };
}

export async function recordCreate(tx: StoreTx, storeId: string, actor: string, id: string | undefined,
  hash: string | undefined, result: { id: string; slug: string }): Promise<void> {
  if (id === undefined) return;
  await tx.insert(s.auditLog).values({ id, storeId, actor, entity: 'blog_post', entityId: result.id,
    action: 'idempotent_create', data: { requestHash: hash, postId: result.id, slug: result.slug } });
}

/** Read-only reconciliation after a possibly successful creation; never another POST. */
export async function readCreate(tx: StoreTx, storeId: string, key: string) {
  const id = receiptId(storeId, key);
  const [receipt] = await tx.select().from(s.auditLog).where(eq(s.auditLog.id, id)).limit(1);
  const data = receipt?.data as { requestHash?: string; postId?: string; slug?: string } | null;
  if (!receipt || receipt.storeId !== storeId || receipt.entity !== 'blog_post' || receipt.action !== 'idempotent_create' ||
      !data || !data.requestHash || !data.postId || !data.slug) throw new HttpError(404, 'create receipt not found');
  return { storeId, id: data.postId, slug: data.slug, requestHash: data.requestHash };
}
