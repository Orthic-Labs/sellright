/**
 * OpenAI Ads Conversions API (#375): one server-to-server `order_created` per order paid with a live payment, sent from
 * the API (never from page code) so a conversion still reaches OpenAI when the browser pixel is blocked.
 *
 * Contract (https://developers.openai.com/ads/conversions-api, checked 2026-10-26): POST
 * https://bzr.openai.com/v1/events?pid=<pixel id>, `Authorization: Bearer <key>`. Event id `purchase_<order code>` is the
 * same `event_id` the storefront's pixel sends on the confirmation page, so OpenAI keeps the first and drops the other.
 * timestamp_ms must lie within the last 7 days. One event per request: a bad event fails its whole batch.
 *
 * User fields are hashed here (SHA-256 hex of the normalised UTF-8 value, OpenAI's rules); obref, IP address, user agent
 * and the geo fields are sent raw, as the API asks. No raw email, phone or name ever leaves the process.
 *
 * Per deployment: off unless OPENAI_CAPI_PIXEL_ID and OPENAI_CAPI_KEY are set (the key is never logged).
 * OPENAI_CAPI_VALIDATE_ONLY (default on) sends `validate_only: true`; turning it off re-sends validated orders live.
 * State lives on the order (`metadata.openaiCapi`), so a pass is idempotent and a restart loses nothing.
 */
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';

export const CAPI_ENDPOINT = 'https://bzr.openai.com/v1/events';
const SEVEN_DAYS_MS = 7 * 24 * 3_600_000;
/** Leave room so an event picked near the window edge is still inside it when OpenAI receives it. */
const WINDOW_MARGIN_MS = 30 * 60_000;
const MAX_TRIES = 8;
const MAX_BACKOFF_MS = 6 * 3_600_000;

// ── normalisation + hashing (OpenAI "send user data" rules) ──────────────────────────────────────────────────────────
export const sha256 = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex');
export const normEmail = (v: unknown): string | null => {
  const e = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
};
/** Country code kept, separators and a leading + / zeroes dropped (+1 (415) 555-2671 → 14155552671). A national number is
 *  read in the order's country first, so it gains its country code. */
export function normPhone(v: unknown, country?: unknown): string | null {
  const raw = typeof v === 'string' ? v.trim() : '';
  if (!raw) return null;
  const parsed = parsePhoneNumberFromString(raw, (typeof country === 'string' && /^[a-z]{2}$/i.test(country) ? country.toUpperCase() : 'US') as CountryCode);
  const digits = parsed?.isValid() ? parsed.number.replace(/^\+/, '') : raw.replace(/[\s().-]/g, '').replace(/^\+/, '').replace(/^0+/, '');
  return /^\d{8,15}$/.test(digits) ? digits : null;
}
/** Lowercased, whitespace and ASCII punctuation removed (Mary-Jane → maryjane). */
export const normName = (v: unknown): string | null => {
  const n = typeof v === 'string' ? v.toLowerCase().replace(/[\s!-/:-@[-`{-~]/g, '') : '';
  return n || null;
};
/** Trimmed, case and other characters kept. */
export const normExternalId = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

const hashed = (values: Array<string | null>) => [...new Set(values.filter((v): v is string => !!v).map(sha256))].slice(0, 3);
const plain = (values: Array<unknown>, max: number) =>
  [...new Set(values.filter((v): v is string => typeof v === 'string' && !!v.trim()).map((v) => v.trim().slice(0, max)))].slice(0, 3);

// ── event ────────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface CapiOrderFacts {
  code: string;
  paidAt: Date;
  currency: string;
  grandTotal: number;
  lines: Array<{ sku: string | null; name: string | null; quantity: number; lineTotal: number }>;
  customer: { id: string; email: string | null; phone: string | null; firstName: string | null; lastName: string | null } | null;
  contactEmail: string | null;
  shippingAddress: Record<string, unknown> | null;
  billingAddress: Record<string, unknown> | null;
  oppref: string | null;
  adMatch: { obref?: string; visitorId?: string; ip?: string; userAgent?: string } | null;
}

/** Split "Ada Lovelace King" into first "Ada", last "Lovelace King" (only used when no customer names exist). */
function splitName(full: unknown): { first: string | null; last: string | null } {
  const parts = typeof full === 'string' ? full.trim().split(/\s+/).filter(Boolean) : [];
  return { first: parts[0] ?? null, last: parts.length > 1 ? parts.slice(1).join(' ') : null };
}

export function buildOrderCreatedEvent(o: CapiOrderFacts, sourceUrl: string) {
  const ship = o.shippingAddress ?? {};
  const bill = o.billingAddress ?? {};
  const country = (ship.country ?? bill.country) as unknown;
  const shipName = splitName(ship.fullName ?? bill.fullName);
  const firsts = [normName(o.customer?.firstName), o.customer?.firstName ? null : normName(shipName.first)];
  const lasts = [normName(o.customer?.lastName), o.customer?.lastName ? null : normName(shipName.last)];
  const user: Record<string, unknown> = {
    emails_sha256: hashed([normEmail(o.contactEmail), normEmail(o.customer?.email)]),
    phone_numbers_sha256: hashed([normPhone(ship.phone, country), normPhone(bill.phone, bill.country ?? country), normPhone(o.customer?.phone, country)]),
    // The storefront hashes the same strings: the customer id when signed in, else its first-party visitor id.
    external_ids_sha256: hashed([normExternalId(o.customer?.id), normExternalId(o.adMatch?.visitorId)]),
    first_names_sha256: hashed(firsts),
    last_names_sha256: hashed(lasts),
    countries: plain([ship.country, bill.country], 2).map((c) => c.toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c)),
    regions: plain([ship.province, bill.province], 128),
    cities: plain([ship.city, bill.city], 128),
    postal_codes: plain([ship.postalCode, bill.postalCode], 32),
    ...(o.adMatch?.obref ? { obref: o.adMatch.obref } : {}),
    ...(o.adMatch?.ip ? { ip_address: o.adMatch.ip } : {}),
    ...(o.adMatch?.userAgent ? { user_agent: o.adMatch.userAgent } : {}),
  };
  for (const k of Object.keys(user)) if (Array.isArray(user[k]) && (user[k] as unknown[]).length === 0) delete user[k];
  return {
    id: `purchase_${o.code}`,
    type: 'order_created' as const,
    timestamp_ms: o.paidAt.getTime(),
    ...(o.oppref ? { oppref: o.oppref } : {}),
    source_url: sourceUrl,
    action_source: 'web' as const,
    user,
    data: {
      type: 'contents' as const,
      amount: Math.round(o.grandTotal),
      currency: o.currency,
      contents: o.lines.filter((l) => l.quantity > 0).slice(0, 50).map((l) => ({
        id: l.sku || l.name || 'item',
        ...(l.name ? { name: l.name } : {}),
        content_type: 'product',
        quantity: l.quantity,
        amount: Math.round(l.lineTotal / l.quantity),
        currency: o.currency,
      })),
    },
  };
}

// ── send ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
export type CapiConfig = { pixelId: string; key: string; validateOnly: boolean; storefrontUrl: string };
export type CapiOutcome = { kind: 'accepted' } | { kind: 'rejected'; status: number; detail: string } | { kind: 'retry'; status: number | null; detail: string };
export type CapiFetch = (url: string, init: RequestInit) => Promise<Response>;

export function capiConfig(): CapiConfig | null {
  const pixelId = env.OPENAI_CAPI_PIXEL_ID?.trim();
  const key = env.OPENAI_CAPI_KEY?.trim();
  if (!pixelId || !key) return null;
  return { pixelId, key, validateOnly: env.OPENAI_CAPI_VALIDATE_ONLY !== '0', storefrontUrl: env.STOREFRONT_URL.replace(/\/+$/, '') };
}

/** Error text for logs and order state: bounded, with anything key-like or address-like masked. */
const detailOf = (text: string) => text.replace(/\s+/g, ' ').replace(/Bearer\s+\S+/gi, 'Bearer ***').replace(/[^\s"@]+@[^\s"@]+/g, '***@***').slice(0, 300);

export async function sendEvent(cfg: CapiConfig, event: ReturnType<typeof buildOrderCreatedEvent>, fetchImpl: CapiFetch = fetch): Promise<CapiOutcome> {
  let res: Response;
  try {
    res = await fetchImpl(`${CAPI_ENDPOINT}?pid=${encodeURIComponent(cfg.pixelId)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ validate_only: cfg.validateOnly, integration_source: 'sellright', events: [event] }),
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
  } catch (e) {
    return { kind: 'retry', status: null, detail: detailOf(e instanceof Error ? e.name + ': ' + e.message : 'network error') };
  }
  const text = await res.text().catch(() => '');
  if (res.ok) return { kind: 'accepted' };
  if (res.status === 408 || res.status === 429 || res.status >= 500) return { kind: 'retry', status: res.status, detail: detailOf(text) };
  return { kind: 'rejected', status: res.status, detail: detailOf(text) };
}

// ── job pass ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface CapiState { status: 'sent' | 'validated' | 'retry' | 'rejected' | 'failed'; tries: number; at: string; nextAt?: string; httpStatus?: number | null; detail?: string }

export const backoffMs = (tries: number) => Math.min(5 * 60_000 * 2 ** Math.max(0, tries - 1), MAX_BACKOFF_MS);

/** Orders due a send: paid with at least one settled LIVE attempt and no test one (#373's rule), paid within the window,
 *  not yet accepted (a validate-only acceptance is re-sent once validate-only is off), retry time reached. */
function dueSql(storeId: string, now: Date, validateOnly: boolean) {
  const windowStart = new Date(now.getTime() - SEVEN_DAYS_MS + WINDOW_MARGIN_MS);
  return sql`o.store_id = ${storeId} AND o.state IN ('Paid', 'PartiallyRefunded', 'Refunded') AND o.deleted_at IS NULL AND NOT o.is_demo
    AND o.placed_at IS NOT NULL AND o.placed_at > ${windowStart}
    AND EXISTS (SELECT 1 FROM payment_attempt pa WHERE pa.order_id = o.id AND pa.status = 'settled' AND pa.mode = 'live')
    AND NOT EXISTS (SELECT 1 FROM payment_attempt pa WHERE pa.order_id = o.id AND pa.status = 'settled' AND pa.mode = 'test')
    AND (o.metadata->'openaiCapi' IS NULL
      OR (o.metadata->'openaiCapi'->>'status' = 'retry' AND (o.metadata->'openaiCapi'->>'nextAt')::timestamptz <= ${now})
      OR (o.metadata->'openaiCapi'->>'status' = 'validated' AND ${!validateOnly}))`;
}

async function loadFacts(storeId: string, orderId: string): Promise<CapiOrderFacts | null> {
  return withStore(storeId, async (tx) => {
    const r = await tx.execute(sql`SELECT o.code, o.placed_at, o.currency, o.grand_total, o.metadata, o.shipping_address, o.billing_address,
        c.id AS customer_id, c.email, c.phone, c.first_name, c.last_name
      FROM "order" o LEFT JOIN customer c ON c.id = o.customer_id WHERE o.id = ${orderId}`);
    const o = (r as unknown as { rows: Array<Record<string, unknown>> }).rows[0];
    if (!o) return null;
    const lines = (await tx.execute(sql`SELECT variant_sku, product_name, variant_name, quantity, cancelled_qty, line_total FROM order_line WHERE order_id = ${orderId} ORDER BY id`) as unknown as { rows: Array<Record<string, unknown>> }).rows;
    const meta = (o.metadata ?? {}) as { contact?: { email?: string }; attribution?: { oppref?: string }; adMatch?: CapiOrderFacts['adMatch'] };
    return {
      code: String(o.code), paidAt: new Date(o.placed_at as string), currency: String(o.currency), grandTotal: Number(o.grand_total),
      lines: lines.map((l) => ({ sku: (l.variant_sku as string) ?? null, name: ((l.product_name as string) || (l.variant_name as string)) ?? null,
        quantity: Number(l.quantity), lineTotal: Number(l.line_total) })),
      customer: o.customer_id ? { id: String(o.customer_id), email: (o.email as string) ?? null, phone: (o.phone as string) ?? null,
        firstName: (o.first_name as string) ?? null, lastName: (o.last_name as string) ?? null } : null,
      contactEmail: meta.contact?.email ?? null,
      shippingAddress: (o.shipping_address as Record<string, unknown>) ?? null, billingAddress: (o.billing_address as Record<string, unknown>) ?? null,
      oppref: meta.attribution?.oppref ?? null,
      adMatch: meta.adMatch ?? null,
    };
  });
}

/**
 * One pass: send every due order for this deployment's store(s). The order's state is written after each send, so a
 * crash replays at most the in-flight order (OpenAI de-duplicates by event id). The client IP and user agent are
 * dropped from the order once OpenAI has accepted the live event (they exist only for this match).
 */
export async function openaiCapiPass(opts: { log?: (m: string) => void; now?: Date; fetchImpl?: CapiFetch; config?: CapiConfig | null; batchLimit?: number } = {}): Promise<{ sent: number; validated: number; retry: number; rejected: number }> {
  const cfg = opts.config === undefined ? capiConfig() : opts.config;
  const out = { sent: 0, validated: 0, retry: 0, rejected: 0 };
  if (!cfg) return out;
  const log = opts.log ?? (() => {});
  const now = opts.now ?? new Date();
  const stores = await pool.query<{ id: string; slug: string }>(env.STORE_SLUG ? 'SELECT id, slug FROM store WHERE slug = $1' : 'SELECT id, slug FROM store', env.STORE_SLUG ? [env.STORE_SLUG] : []);
  for (const st of stores.rows) {
    const due = await withStore(st.id, (tx) => tx.execute(sql`SELECT o.id, o.code, coalesce((o.metadata->'openaiCapi'->>'tries')::int, 0) AS tries
      FROM "order" o WHERE ${dueSql(st.id, now, cfg.validateOnly)} ORDER BY o.placed_at LIMIT ${opts.batchLimit ?? 50}`));
    for (const row of (due as unknown as { rows: Array<{ id: string; code: string; tries: number }> }).rows) {
      const facts = await loadFacts(st.id, row.id);
      if (!facts) continue;
      const outcome = await sendEvent(cfg, buildOrderCreatedEvent(facts, `${cfg.storefrontUrl}/checkout/confirmation/${encodeURIComponent(facts.code)}`), opts.fetchImpl);
      const tries = Number(row.tries) + 1;
      let state: CapiState;
      if (outcome.kind === 'accepted') state = { status: cfg.validateOnly ? 'validated' : 'sent', tries, at: now.toISOString() };
      else if (outcome.kind === 'rejected') state = { status: 'rejected', tries, at: now.toISOString(), httpStatus: outcome.status, detail: outcome.detail };
      else if (tries >= MAX_TRIES) state = { status: 'failed', tries, at: now.toISOString(), httpStatus: outcome.status, detail: outcome.detail };
      else state = { status: 'retry', tries, at: now.toISOString(), nextAt: new Date(now.getTime() + backoffMs(tries)).toISOString(), httpStatus: outcome.status, detail: outcome.detail };
      const dropNetwork = state.status === 'sent';
      await withStore(st.id, (tx) => tx.execute(sql`UPDATE "order" SET metadata = jsonb_set(
          CASE WHEN ${dropNetwork} THEN coalesce(metadata, '{}'::jsonb) #- '{adMatch,ip}' #- '{adMatch,userAgent}' ELSE coalesce(metadata, '{}'::jsonb) END,
          '{openaiCapi}', ${JSON.stringify(state)}::jsonb) WHERE id = ${row.id}`));
      if (state.status === 'sent') out.sent++; else if (state.status === 'validated') out.validated++; else if (state.status === 'retry') out.retry++; else out.rejected++;
      log(`[openai-capi] ${st.slug}: ${facts.code} ${state.status}${cfg.validateOnly ? ' (validate_only)' : ''}${state.httpStatus ? ` http=${state.httpStatus}` : ''}${state.detail ? ` ${state.detail}` : ''}`);
    }
  }
  return out;
}
