/**
 * CartService — the single, server-owned shopping cart.
 *
 * The server holds the cart (lines, price, stock, coupon, revision); the
 * browser holds only the opaque `sr_cart` token (the API has no httpOnly
 * cookie of its own — see `packages/api/src/routes/cart.ts` — so the client
 * persists the token itself, same mechanism as before). Every mutation is
 * either a BLIND APPEND (commutative — no revision) or a revisioned ABSOLUTE
 * SET that adopts the server's snapshot and retries exactly once on a 409.
 *
 * Every cart operation of a cooperating tab runs under ONE exclusive Web Lock
 * (`sr-cart`), taken exactly once per public operation: public methods enter
 * `exclusive`, private `…InLock` internals never do (Web Locks are not
 * re-entrant). Code already inside the lock (checkout) uses the `CartLockScope`
 * handed out by `withLock`. See docs/plans/2026-10-11-stale-cart-recovery.md §4.1a.
 *
 * See `~/sellright/types/cart.ts` for the full API contract, the native
 * Cart/CartLine types, and the fail-closed stock rules.
 */
import { sellright, SellRightError } from '~/sellright/client';
import { srMe, srErrorStatus, srLegacyCartMigration } from '~/utils/sellright';
import { CountryPreferenceService } from './CountryPreferenceService';
import { classifyOrderState } from './order-state';
import { theme } from '~/theme/theme.config';
import {
  EMPTY_CART,
  type Cart,
  type CartLine,
  type CartLineEnrichment,
  type CartConflict,
  type AddLineResult,
  type CartMutationResult,
  type ServerCart,
} from '~/sellright/types/cart';

const TOKEN_COOKIE = 'sr_cart';
/** Pre-native cart key, read exactly once for a lossless one-time migration. */
export const LEGACY_CART_KEY = 'vendure_local_cart';
const LEGACY_CLAIM_KEY = 'sr_legacy_cart_claim';
const CART_INTENT_KEY = 'sr_cart_intent';
// SSR carries only presence of legacy transport; this flag never authorizes adoption.
const LEGACY_PENDING_COOKIE = 'sr_legacy_cart';
/** The single origin-wide lock every cart operation of a cooperating tab runs under. */
const CART_LOCK = 'sr-cart';
/** Reason returned by `applyCoupon` when a newer cart request replaced it mid-flight. */
export const COUPON_SUPERSEDED = 'The cart changed while checking that code. Please try again.';
const MISSING_CART_MESSAGE = 'Your cart expired — please re-add your items';
const UNSUPPORTED_MESSAGE = 'Please update your browser to use the cart.';

/** A successful cart read with no body (HTTP 204, JSON null): the server said nothing about the cart. Deliberately NOT
 *  `not_found` — only the typed 404 CART_NOT_FOUND is a definitive "the cart is gone". */
export const EMPTY_CART_RESPONSE = 'empty_response';
const emptyCartResponse = (): CartError => new CartError(EMPTY_CART_RESPONSE, 'The cart service returned an empty response');

export class CartError extends Error {
  constructor(
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'CartError';
  }
}

/** The cart was already converted into an order: its token is kept (it is the way back to an unpaid order) and the
 *  failed mutation is never retried against it. */
export class ConvertedCartError extends CartError {
  constructor(message = 'This cart was already checked out — continue to checkout to pay for it.') {
    super('converted', message);
    this.name = 'ConvertedCartError';
  }
}

/** The original order behind a converted cart, as `GET /v1/shop/cart/{token}/checkout` reports it. */
export interface ConvertedCheckout {
  code: string;
  state: string;
  grandTotal: number;
  receiptToken: string;
  currency: string;
}

export type ConvertedLookup =
  | { ok: true; order: ConvertedCheckout }
  /** `not_converted`: the cart is not converted or its order is gone (404 ORDER_NOT_FOUND). `unavailable`: anything else. */
  | { ok: false; reason: 'not_converted' | 'unavailable' };

/**
 * Capability for code that ALREADY holds the cart lock (see `CartService.withLock`). Its methods are the unlocked
 * internals, so a caller inside the lock never re-enters it. Valid until the callback settles; afterwards every
 * method throws.
 */
export interface CartLockScope {
  /** Live read of the cart named by the cookie; classified failures retire/install as the error boundary says. */
  readFresh(): Promise<ServerCart>;
  /** Adopt a snapshot returned in a checkout 409 — only if it still belongs to `requestToken`, the cart submitted. */
  adoptConflict(cart: ServerCart, requestToken: string): void;
  /** Retire `requestToken` locally (merged cart) — only if the cookie still names it. */
  retire(requestToken: string): void;
}

export interface LegacyCartSnapshot {
  items: Array<{ variantId: string; quantity: number }>;
  couponCode: string | null;
  /** Present only for newer saved intent; absence preserves old claim bytes. */
  couponCodes?: string[];
  countryCode: string | null;
  countryExplicit: boolean;
}
/** Only intent survives. Cached money, discounts & stock are never read. */
export function parseLegacyCartSnapshot(raw: string): LegacyCartSnapshot {
  const value = JSON.parse(raw);
  if (!value || !Array.isArray(value.items) || value.items.length > 200) throw new CartError('legacy_invalid', 'Saved cart needs reconciliation');
  const items = value.items.map((item: { productVariantId?: unknown; productVariant?: { id?: unknown }; quantity?: unknown }) => {
    const variantId = String(item?.productVariantId ?? item?.productVariant?.id ?? '');
    const quantity = item?.quantity;
    if (!/^\d{1,20}$/.test(variantId) || typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 9999) {
      throw new CartError('legacy_invalid', 'Saved cart contains an unresolved item; original cart is preserved');
    }
    return { variantId, quantity };
  });
  if ('couponCodes' in value && (!Array.isArray(value.couponCodes) || !value.couponCodes.every((code: unknown) => typeof code === 'string' && code.length > 0 && code.length <= 200))) {
    throw new CartError('legacy_invalid', 'Saved coupon intent needs reconciliation; original cart is preserved');
  }
  return { items,
    couponCode: typeof value.appliedCoupon?.code === 'string' && value.appliedCoupon.code.length <= 200 ? value.appliedCoupon.code : null,
    ...(Array.isArray(value.couponCodes) && value.couponCodes.every((code: unknown) => typeof code === 'string' && code.length > 0 && code.length <= 200)
      ? { couponCodes: couponMembership(value.couponCodes) } : {}),
    countryCode: typeof value.countryCode === 'string' && /^[A-Z]{2}$/.test(value.countryCode) ? value.countryCode : null,
    countryExplicit: value.countryExplicitlySet === true,
  };
}

/** Generic coupon identity is case-insensitive; whitespace belongs to code identity. */
export const couponMembership = (codes: readonly string[]): string[] => {
  const seen = new Set<string>();
  return codes.filter(code => { const key = code.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
};

const isStaleConflict = (c: CartConflict | null): c is CartConflict => !!c && (c.code === 'stale' || c.code === 'revision_required');

export class CartService {
  private static cart: Cart = EMPTY_CART;
  private static couponCodes: string[] | null = null;
  private static pendingIntentMigration = false;
  private static quoteContext: { shipCountry?: string; shippingMethodCode?: string; redeemPoints?: number; pricingIntent?: 'preview' | 'checkout' } = {};

  /** Context changes invalidate in-flight quotes; every amount still comes from API. */
  static setQuoteContext(context: { shipCountry?: string; shippingMethodCode?: string; redeemPoints?: number; pricingIntent?: 'preview' | 'checkout' }): void {
    if (JSON.stringify(context) === JSON.stringify(this.quoteContext)) return;
    this.quoteContext = { ...context };
    this.snapshotSeq++;
  }
  private static quoteCountry(): string {
    return this.quoteContext.shipCountry ?? CountryPreferenceService.getCountry();
  }
  private static enrichment = new Map<string, CartLineEnrichment>();
  private static listeners = new Set<() => void>();
  /** True while this tab owns `sr-cart` (set by `exclusive`). Misuse tripwire for the unlocked internals. */
  private static lockHeld = false;
  /**
   * Request-sequence guard for server-snapshot reads. Operations of a cooperating tab are serialised by the lock,
   * but a lock-free `refresh` (no Web Locks) and a cookie changed under an in-flight request can still land out of
   * order; without a guard the OLDER response overwrites the newer mirror. Every read claims a number before it is
   * sent (`claimSeq`) and only adopts its response while that number is still the latest (`isCurrent`). Any install
   * or retirement bumps the counter too. This orders RESPONSES only — it is not a cache and holds no stock data.
   */
  private static snapshotSeq = 0;

  // ── subscription ──────────────────────────────────────────────────────
  static onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private static notify(): void {
    for (const cb of this.listeners) {
      try {
        cb();
      } catch (e) {
        console.error('[CartService] onChange listener failed:', e);
      }
    }
  }

  private static claimSeq(): number {
    return ++this.snapshotSeq;
  }

  private static isCurrent(seq: number): boolean {
    return seq === this.snapshotSeq;
  }

  // ── read accessors ───────────────────────────────────────────────────
  static getCart(): Cart {
    return this.cart;
  }

  /** The cart this browser points at: the cookie only. The mirror may still name an older cart another tab replaced. */
  static token(): string | null {
    return this.readTokenCookie();
  }

  static revision(): number {
    return this.cart.revision;
  }

  // ── token cookie (non-httpOnly — the API has no cookie of its own) ─────
  private static readTokenCookie(): string | null {
    if (typeof document === 'undefined') return null;
    const m = document.cookie.match(new RegExp(`(?:^|; )${TOKEN_COOKIE}=([^;]*)`));
    return m ? decodeURIComponent(m[1]) : null;
  }

  private static writeTokenCookie(token: string): void {
    if (typeof document === 'undefined' || !token) return;
    const secure = typeof location !== 'undefined' && location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${TOKEN_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${30 * 24 * 60 * 60}; SameSite=Lax${secure}`;
  }

  private static clearTokenCookie(): void {
    if (typeof document === 'undefined') return;
    document.cookie = `${TOKEN_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
  }

  // ── the lock ──────────────────────────────────────────────────────────
  private static hasLocks(): boolean {
    return typeof navigator !== 'undefined' && 'locks' in navigator && !!navigator.locks;
  }

  /** Run `fn` as the ONE lock owner of a public operation. Fails closed — before `fn`, so before any network call —
   *  when Web Locks are missing: there is no synchronous fallback that could be claimed safe. */
  private static async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.hasLocks()) throw new CartError('unsupported', UNSUPPORTED_MESSAGE);
    return navigator.locks.request(CART_LOCK, { mode: 'exclusive' }, async () => {
      this.lockHeld = true;
      try {
        this.syncToCookie();
        return await fn();
      } finally {
        this.lockHeld = false;
      }
    });
  }

  private static assertHeld(): void {
    if (!this.lockHeld) throw new Error('CartService: cart internals used outside the cart lock');
  }

  /**
   * Hold the cart lock across `fn` — for the checkout, whose live read and order POST are one locked unit. `fn`
   * receives the scope whose methods are the unlocked internals; it must use those, never the public methods
   * (a public call from inside would wait for the lock this very call holds).
   */
  static withLock<T>(fn: (scope: CartLockScope) => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      let open = true;
      const guard = <A extends unknown[], R>(f: (...args: A) => R) => (...args: A): R => {
        if (!open) throw new Error('CartService: lock scope used after the lock was released');
        return f(...args);
      };
      const scope: CartLockScope = {
        readFresh: guard(() => this.readFreshInLock()),
        adoptConflict: guard((cart: ServerCart, requestToken: string) => {
          this.install(cart, requestToken);
        }),
        retire: guard((requestToken: string) => this.retire(requestToken)),
      };
      try {
        return await fn(scope);
      } finally {
        open = false;
      }
    });
  }

  /** Another tab may have replaced or cleared the cookie while this one waited for the lock: the mirror, coupon and
   *  enrichment then describe a cart this browser no longer points at. Reset them before the operation proceeds. */
  private static syncToCookie(): void {
    if (this.cart.token && this.cart.token !== this.readTokenCookie()) this.resetMirror();
  }

  private static resetMirror(): void {
    this.snapshotSeq++; // a read still in flight must not resurrect the dropped cart
    this.couponCodes = null;
    this.pendingIntentMigration = false;
    this.enrichment.clear();
    this.cart = EMPTY_CART;
    this.notify();
  }

  // ── enrichment (client-only display metadata, keyed by SKU) ─────────────
  private static setEnrichment(sku: string, enrichment?: CartLineEnrichment): void {
    if (!enrichment) return;
    this.enrichment.set(sku, { ...this.enrichment.get(sku), ...enrichment });
  }

  private static toCartLine = (line: ServerCart['lines'][number]): CartLine => ({
    ...line,
    ...this.enrichment.get(line.sku),
    ...(line.isPreOrder === undefined ? {} : { isPreOrder: line.isPreOrder }),
    ...(line.shipDate === undefined ? {} : { shipDate: line.shipDate }),
    ...(line.shipDateLabel === undefined ? {} : { shipDateLabel: line.shipDateLabel }),
  });

  private static toCart(server: ServerCart): Cart {
    return { ...server, lines: server.lines.map(this.toCartLine) };
  }

  // ── mirror install / retirement / creation ────────────────────────────
  /**
   * Write a server snapshot into the MIRROR — never the cookie, never a different cart's identity. Applies only when
   * the snapshot, the request that produced it and the cookie all name the same token; otherwise a response for T
   * cannot touch U's mirror. Returns the SKUs that vanished unexpectedly, or `null` when it did not apply.
   */
  private static install(server: ServerCart, requestToken: string, expectedRemoval?: string): string[] | null {
    if (server.token !== requestToken || this.readTokenCookie() !== requestToken) return null;
    const prior = new Set(this.cart.lines.map((l) => l.sku));
    const next = new Set(server.lines.map((l) => l.sku));
    const dropped = [...prior].filter((sku) => sku !== expectedRemoval && !next.has(sku));
    this.snapshotSeq++; // supersede any read issued before this snapshot landed
    this.cart = this.toCart(server);
    if (Array.isArray(server.couponCodes)) {
      this.couponCodes = couponMembership(server.couponCodes);
      this.persistIntent();
    }
    // Keep enrichment only for lines still present — stale entries would leak
    // display metadata onto an unrelated future line that reuses the SKU.
    for (const sku of [...this.enrichment.keys()]) {
      if (!next.has(sku)) this.enrichment.delete(sku);
    }
    this.notify();
    return dropped;
  }

  /** Drop the token + mirror — no network call — but only if the cookie still names `requestToken`: a response for T
   *  never retires U. */
  private static retire(requestToken: string): void {
    this.assertHeld();
    if (this.readTokenCookie() !== requestToken) return;
    this.clearTokenCookie();
    this.resetMirror();
  }

  /** Start over with no cart (the cart-link seed's replace semantics, brand views PR2 / plan v3.1 §3.5): forget this browser's cart
   *  token and mirror, no network call; the next add creates a new cart. The previous cart stays on the server untouched. */
  static discard(): Promise<void> {
    return this.exclusive(async () => {
      const token = this.readTokenCookie();
      if (token) this.retire(token);
      else this.resetMirror();
    });
  }

  /** Adopt a cart snapshot handed back inside a checkout 409 (stale cart), bound to the token that was submitted. */
  static adoptConflict(cart: ServerCart, requestToken: string): Promise<void> {
    return this.exclusive(async () => {
      this.install(cart, requestToken);
    });
  }

  /** Legacy work needs a write lock; ordinary native boot retains its read-only browser fallback. */
  static bootstrap(): Promise<CartMutationResult> {
    this.syncToCookie();
    this.restoreIntent();
    if (!this.hasLegacyIntent() && !this.pendingIntentMigration) return this.refresh();
    return this.exclusive(async () => {
      if (this.hasLegacyIntent()) await this.migrateLegacyInLock(true);
      if (this.pendingIntentMigration && this.readTokenCookie()) {
        const legacyCodes = [...(this.couponCodes ?? [])];
        await this.withRevisionRetryInLock((token, revision) => sellright().PATCH('/v1/shop/cart/{token}/lines', {
          params: { path: { token } }, body: { lines: [], couponCodes: couponMembership([...(this.cart.couponCodes ?? []), ...legacyCodes]), expectedRevision: revision,
            ...this.quoteContext, shipCountry: this.quoteCountry() },
        }));
        this.pendingIntentMigration = false;
        this.persistIntent();
      }
      return this.refreshInLock();
    });
  }

  private static hasLegacyTransport(): boolean {
    return typeof document !== 'undefined' && /(?:^|;\s*)(?:authToken=[^;]+|sr_legacy_cart=1)(?:;|$)/.test(document.cookie);
  }

  private static hasLegacyIntent(): boolean {
    if (theme.isDemo || typeof window === 'undefined') return false;
    if (this.hasLegacyTransport()) return true;
    try { return localStorage.getItem(LEGACY_CART_KEY) !== null; } catch { return false; }
  }

  /** Persist coupon intent only; every read still revalidates it with current server facts. */
  private static persistIntent(): void {
    // Keep the old replay intent until its revision-fenced membership lift commits.
    if (this.pendingIntentMigration) return;
    try { localStorage.setItem(CART_INTENT_KEY, JSON.stringify({ version: 2, token: this.readTokenCookie(), couponCodes: this.couponCodes })); } catch { /* Current tab keeps intent. */ }
  }

  private static restoreIntent(): void {
    try {
      const value = JSON.parse(localStorage.getItem(CART_INTENT_KEY) ?? 'null');
      if (value?.token !== this.readTokenCookie()) return;
      if (value.version === 2 && Array.isArray(value.couponCodes) && value.couponCodes.every((code: unknown) => typeof code === 'string' && code.length > 0)) {
        this.couponCodes = couponMembership(value.couponCodes);
      } else if (typeof value.couponCode === 'string' || value.couponCode === null) {
        this.couponCodes = value.couponCode ? [value.couponCode] : [];
        this.pendingIntentMigration = true;
      }
    } catch { /* Untrusted transport never overrides server pricing. */ }
  }

  private static couponQuery(): { shipCountry?: string; shippingMethodCode?: string; redeemPoints?: number; pricingIntent?: 'preview' | 'checkout' } {
    // Read durable membership before merging any pending legacy intent.
    return { ...this.quoteContext };
  }

  private static async bootstrapAuth(): Promise<void> {
    try { await srMe(); } catch (error) { if (srErrorStatus(error) !== 401) throw error; }
  }

  private static async migrateLegacyInLock(includeSource = false): Promise<boolean> {
    this.assertHeld();
    if (!this.hasLegacyIntent()) return false;
    // Storage failure is surfaced before any server write; never lose a replay capability.
    const raw = localStorage.getItem(LEGACY_CART_KEY);
    if (raw === null && (!includeSource || !this.hasLegacyTransport() || this.readTokenCookie())) return false;
    const snapshot = raw === null ? null : parseLegacyCartSnapshot(raw);
    if (this.hasLegacyTransport()) await this.bootstrapAuth();
    const bytes = new TextEncoder().encode(raw ?? '\0');
    const fingerprint = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    let claimId: string;
    const priorRaw = localStorage.getItem(LEGACY_CLAIM_KEY);
    let prior: { fingerprint?: unknown; claimId?: unknown } | null = null;
    try { prior = priorRaw ? JSON.parse(priorRaw) : null; } catch { /* New opaque receipt below. */ }
    if (prior?.fingerprint === fingerprint && typeof prior.claimId === 'string' && /^[0-9a-f-]{36}$/i.test(prior.claimId)) claimId = prior.claimId;
    else {
      claimId = crypto.randomUUID();
      localStorage.setItem(LEGACY_CLAIM_KEY, JSON.stringify({ fingerprint, claimId }));
    }
    const receipt = await srLegacyCartMigration({ claimId, items: snapshot?.items ?? null,
      couponCode: snapshot?.couponCode, ...(snapshot?.couponCodes ? { couponCodes: snapshot.couponCodes } : {}), countryCode: snapshot?.countryCode });
    if (receipt.receipt !== claimId || (raw !== null && !receipt.cart)) throw new CartError('legacy_receipt', 'Saved cart transfer has no confirmed receipt');
    if (receipt.cart) {
      this.writeTokenCookie(receipt.cart.token);
      this.couponCodes = receipt.couponCodes ?? (receipt.couponCode ? [receipt.couponCode] : []);
      this.persistIntent();
      this.install(receipt.cart, receipt.cart.token);
    }
    if (receipt.countryCode) {
      if (snapshot?.countryExplicit) CountryPreferenceService.setCountry(receipt.countryCode);
      else CountryPreferenceService.setCountryFromGeolocation(receipt.countryCode);
    }
    document.cookie = `${LEGACY_PENDING_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
    // If an old tab edited the blob during this request, preserve its newer intent.
    if (raw !== null && localStorage.getItem(LEGACY_CART_KEY) === raw) localStorage.removeItem(LEGACY_CART_KEY);
    return !!receipt.cart;
  }

  // ── cart lifecycle ────────────────────────────────────────────────────
  private static async ensureCart(): Promise<string> {
    this.assertHeld();
    // Re-read inside the lock: another tab may have created the cart while this one waited.
    return this.readTokenCookie() ?? (await this.createCart());
  }

  /** Existing browser blobs transfer through an atomic receipt before ordinary creation. */
  private static async createCart(): Promise<string> {
    if (await this.migrateLegacyInLock()) return this.readTokenCookie()!;
    const { data } = await sellright().POST('/v1/shop/cart', { body: {} });
    if (!data) throw new CartError(undefined, 'Could not create a cart');
    this.writeTokenCookie(data.token);
    this.install(data, data.token);
    return data.token;
  }

  /** Ensure the mirror's revision is live (cold start reads it via GET). */
  private static async ensureRevision(token: string): Promise<number> {
    if (this.cart.token === token && this.cart.revision) return this.cart.revision;
    const seq = this.claimSeq();
    const { data } = await sellright().GET('/v1/shop/cart/{token}', {
      params: { path: { token }, query: { ...this.couponQuery(), shipCountry: this.quoteCountry() } },
    });
    if (!data) throw emptyCartResponse();
    // The revision is still the right base for the mutation that asked for it;
    // only the mirror write is skipped when a newer request has superseded us.
    if (this.isCurrent(seq)) this.install(data, token);
    return data.revision;
  }

  private static asConflict(e: unknown): CartConflict | null {
    if (!(e instanceof SellRightError) || e.status !== 409) return null;
    const body = e.body as CartConflict | undefined;
    return body && typeof body.revision === 'number' && body.cart ? body : null;
  }

  /**
   * The one error boundary. Returns the error to throw, after applying its local effect for request token `token`:
   *  - 404 CART_NOT_FOUND → retire `token`, `CartError('not_found')`.
   *  - 409 merged → retire `token`, `CartError('merged')`.
   *  - 409 converted → keep the token, install the converted snapshot, `ConvertedCartError`.
   *  - anything else (other 404 codes, network errors, timeouts, 5xx, stale conflicts) → the error itself, with the
   *    token and mirror unchanged.
   */
  private static classify(e: unknown, token: string): unknown {
    if (!(e instanceof SellRightError)) return e;
    if (e.status === 404 && e.code === 'CART_NOT_FOUND') {
      this.retire(token);
      return new CartError('not_found', MISSING_CART_MESSAGE);
    }
    const conflict = this.asConflict(e);
    if (conflict?.code === 'merged') {
      this.retire(token);
      return new CartError('merged', 'This cart was merged into your account');
    }
    if (conflict?.code === 'converted') {
      this.install(conflict.cart, token);
      return new ConvertedCartError();
    }
    return e;
  }

  /** Run a revisioned mutation; on a stale/revision_required 409 adopt the server's snapshot and retry exactly once
   *  with the fresh revision. Never loops further. Runs inside the lock. */
  private static async withRevisionRetryInLock(
    mutate: (token: string, revision: number) => Promise<{ data?: ServerCart }>,
    expectedRemoval?: string,
  ): Promise<CartMutationResult> {
    this.assertHeld();
    const token = await this.ensureCart();
    let revision: number;
    try {
      revision = await this.ensureRevision(token);
    } catch (e) {
      throw this.classify(e, token);
    }
    const attempt = async (rev: number): Promise<CartMutationResult> => {
      const { data } = await mutate(token, rev);
      if (!data) throw new CartError(undefined, "Couldn't update cart");
      const quoted = await this.inQuoteContext(data, token);
      const dropped = this.install(quoted, token, expectedRemoval) ?? [];
      return { cart: this.cart, dropped };
    };
    try {
      return await attempt(revision);
    } catch (e) {
      const conflict = this.asConflict(e);
      if (!isStaleConflict(conflict)) throw this.classify(e, token);
      // stale / revision_required — adopt the authoritative snapshot, retry once.
      this.install(await this.inQuoteContext(conflict.cart, token), token, expectedRemoval);
      try {
        return await attempt(conflict.revision);
      } catch (e2) {
        if (isStaleConflict(this.asConflict(e2))) {
          throw new CartError('conflict', 'Cart changed — review the updated cart and try again');
        }
        throw this.classify(e2, token);
      }
    }
  }

  // ── mutations ─────────────────────────────────────────────────────────

  private static async inQuoteContext(server: ServerCart, token: string): Promise<ServerCart> {
    if (this.quoteContext.pricingIntent !== 'checkout' || server.pricingIntent === 'checkout') return server;
    const { data } = await sellright().GET('/v1/shop/cart/{token}', {
      params: { path: { token }, query: { ...this.couponQuery(), shipCountry: this.quoteCountry() } },
    });
    if (!data) throw emptyCartResponse();
    return data;
  }

  /** Add (or increment) a line. Blind append — commutative, no revision. `applied`/`line` describe this add's own response
   *  (brand views PR2 §5); existing callers ignore them. */
  static addLine(sku: string, quantity: number, enrichment?: CartLineEnrichment): Promise<AddLineResult> {
    return this.exclusive(async () => {
      this.setEnrichment(sku, enrichment);
      const token = await this.ensureCart();
      try {
        const { data } = await sellright().PATCH('/v1/shop/cart/{token}/lines', {
          params: { path: { token } },
          body: { lines: [{ sku, quantity }], ...this.quoteContext, shipCountry: this.quoteCountry() },
        });
        if (!data) throw new CartError(undefined, "Couldn't add item to cart");
        const quoted = await this.inQuoteContext(data, token);
        const installed = this.install(quoted, token);
        const line = quoted.lines.find((l) => l.sku === sku) ?? null;
        return { cart: this.cart, dropped: installed ?? [], applied: installed !== null, line };
      } catch (e) {
        // No automatic retry of the append after an uncertain result.
        throw this.classify(e, token);
      }
    });
  }

  /** Set a line to an absolute quantity (<= 0 removes it). Revisioned. */
  static updateLine(sku: string, quantity: number, enrichment?: CartLineEnrichment): Promise<CartMutationResult> {
    return this.exclusive(async () => {
      this.setEnrichment(sku, enrichment);
      const qty = Math.max(0, quantity);
      return this.withRevisionRetryInLock(
        (token, revision) =>
          sellright().PATCH('/v1/shop/cart/{token}/lines', {
            params: { path: { token } },
            body: {
              lines: [{ sku, quantity: qty }],
              expectedRevision: revision,
              ...this.quoteContext, shipCountry: this.quoteCountry(),
            },
          }),
        qty <= 0 ? sku : undefined,
      );
    });
  }

  /** Remove a line entirely — sugar for `updateLine(sku, 0)`; takes no lock of its own (updateLine owns it). */
  static removeLine(sku: string): Promise<CartMutationResult> {
    return this.updateLine(sku, 0);
  }

  /** Re-fetch the server-priced cart (live stock/price/coupon) — used for the
   *  LOCKED stock checks: cart open, checkout entry, and pre-submit.
   *  Without Web Locks this is a read-only refresh: it installs the mirror under the token fence and never retires. */
  static refresh(): Promise<CartMutationResult> {
    return this.hasLocks() ? this.exclusive(() => this.refreshInLock()) : this.refreshReadOnly();
  }

  private static async refreshInLock(): Promise<CartMutationResult> {
    this.assertHeld();
    const token = this.readTokenCookie();
    if (!token) return { cart: this.cart, dropped: [] };
    const seq = this.claimSeq();
    try {
      const { data } = await sellright().GET('/v1/shop/cart/{token}', {
        params: { path: { token }, query: { ...this.couponQuery(), shipCountry: this.quoteCountry() } },
      });
      if (!data) throw emptyCartResponse();
      // Superseded by a newer read/mutation/retirement: its result is the truth.
      if (!this.isCurrent(seq)) return { cart: this.cart, dropped: [] };
      const dropped = this.install(data, token) ?? [];
      return { cart: this.cart, dropped };
    } catch (e) {
      throw this.classify(e, token);
    }
  }

  private static async refreshReadOnly(): Promise<CartMutationResult> {
    this.syncToCookie();
    const token = this.readTokenCookie();
    if (!token) return { cart: this.cart, dropped: [] };
    const seq = this.claimSeq();
    try {
      const { data } = await sellright().GET('/v1/shop/cart/{token}', {
        params: { path: { token }, query: { ...this.couponQuery(), shipCountry: this.quoteCountry() } },
      });
      if (!data) throw emptyCartResponse();
      if (!this.isCurrent(seq)) return { cart: this.cart, dropped: [] };
      const dropped = this.install(data, token) ?? [];
      return { cart: this.cart, dropped };
    } catch (e) {
      // Without the lock a cookie must never be cleared: report the missing cart, keep the token.
      if (e instanceof SellRightError && e.status === 404 && e.code === 'CART_NOT_FOUND') {
        throw new CartError('not_found', MISSING_CART_MESSAGE);
      }
      throw e;
    }
  }

  /** Live read for the pre-submit stock check. Returns the exact server response of THIS request so the caller
   *  validates what the server just said, not the shared mirror. Fail-closed: a missing cart cookie, an empty body,
   *  a 404 (which also retires the local cart) or any failed read throws. Takes the lock; checkout code already
   *  inside `withLock` uses `scope.readFresh()` instead. */
  static readFresh(): Promise<ServerCart> {
    return this.exclusive(() => this.readFreshInLock());
  }

  private static async readFreshInLock(): Promise<ServerCart> {
    this.assertHeld();
    const token = this.readTokenCookie();
    if (!token) throw new CartError('not_found', MISSING_CART_MESSAGE);
    const seq = this.claimSeq();
    try {
      const { data } = await sellright().GET('/v1/shop/cart/{token}', {
        params: { path: { token }, query: { ...this.couponQuery(), shipCountry: this.quoteCountry() } },
      });
      if (!data) throw emptyCartResponse();
      if (this.isCurrent(seq)) this.install(data, token);
      return data;
    } catch (e) {
      throw this.classify(e, token);
    }
  }

  /** Validate + apply a coupon — the server re-prices the real cart; never a
   *  client-side guess. */
  static applyCoupon(code: string): Promise<{ valid: boolean; reason?: string }> {
    return this.exclusive(async () => {
      const requestToken = await this.ensureCart();
      await this.ensureRevision(requestToken);
      if (this.readTokenCookie() !== requestToken) return { valid: false, reason: COUPON_SUPERSEDED };
      const codes = couponMembership([...(this.couponCodes ?? this.cart.couponCodes ?? []), code]);
      const result = await this.withRevisionRetryInLock((token, revision) => sellright().PATCH('/v1/shop/cart/{token}/lines', {
        params: { path: { token } }, body: { lines: [], couponCodes: couponMembership([...(this.couponCodes ?? this.cart.couponCodes ?? []), code]), expectedRevision: revision,
          ...this.quoteContext, shipCountry: this.quoteCountry() },
      }));
      if (this.readTokenCookie() !== requestToken || result.cart.token !== requestToken) return { valid: false, reason: COUPON_SUPERSEDED };
      const data = result.cart;
      const coupon = data.coupons?.find(c => c.code.toLowerCase() === code.toLowerCase()) ?? data.coupon;
      if (coupon?.applied) {
        this.couponCodes = data.couponCodes ?? codes;
        this.persistIntent();
        return { valid: true };
      }
      return { valid: false, reason: coupon?.reason ?? 'Invalid or expired code' };
    });
  }

  /** Remove one coupon without changing other membership; no code clears legacy intent. */
  static removeCoupon(code?: string): Promise<CartMutationResult> {
    return this.exclusive(async () => {
      const token = this.readTokenCookie();
      if (!token) return { cart: this.cart, dropped: [] };
      await this.ensureRevision(token);
      if (this.readTokenCookie() !== token) throw new CartError('conflict', 'Cart changed — review the updated cart and try again');
      return this.withRevisionRetryInLock((token, revision) => sellright().PATCH('/v1/shop/cart/{token}/lines', {
        params: { path: { token } }, body: { lines: [], couponCodes: code === undefined ? []
          : (this.couponCodes ?? this.cart.couponCodes ?? []).filter(member => member.toLowerCase() !== code.toLowerCase()), expectedRevision: revision,
          ...this.quoteContext, shipCountry: this.quoteCountry() },
      }));
    });
  }

  /** Capture the shopper's email on the cart (abandoned-cart recovery). */
  static captureEmail(email: string): Promise<CartMutationResult> {
    return this.exclusive(() =>
      this.withRevisionRetryInLock((token, revision) =>
        sellright().PATCH('/v1/shop/cart/{token}', {
          params: { path: { token } },
          body: { email, expectedRevision: revision },
        }),
      ),
    );
  }

  /** Fold the guest cart into the logged-in customer. Call once, after auth. */
  static merge(): Promise<CartMutationResult> {
    return this.exclusive(() =>
      this.withRevisionRetryInLock((token, revision) =>
        sellright().POST('/v1/shop/cart/{token}/merge', {
          params: { path: { token }, query: { expectedRevision: revision } },
        }),
      ),
    );
  }

  /** NOT used by the checkout flow: PLACE ORDER submits the snapshot of `readFresh` (via
   *  `refreshStockBeforeSubmit`) so the validated read is the submission base. Kept for non-checkout callers only.
   *  Fresh server cart: re-reads so `expectedRevision` is a live base. `null` when no cart exists or the read failed.
   *  `status` distinguishes 'converted' (resume the original order) from 'merged' (terminal — retired). */
  static checkoutSnapshot(): Promise<{ token: string; revision: number; status: string } | null> {
    return this.exclusive(async () => {
      const token = this.readTokenCookie();
      if (!token) return null;
      const seq = this.claimSeq();
      try {
        const { data } = await sellright().GET('/v1/shop/cart/{token}', {
          params: { path: { token }, query: { ...this.couponQuery(), shipCountry: this.quoteCountry() } },
        });
        if (!data) return null;
        // The revision/status are facts about THIS response and stay valid as
        // the checkout base; only the mirror write yields to a newer request.
        if (this.isCurrent(seq)) this.install(data, token);
        return { token, revision: data.revision, status: data.status };
      } catch (e) {
        this.classify(e, token); // applies the local effect (retire / converted mirror); the caller only needs "no snapshot"
        return null;
      }
    });
  }

  // ── converted carts ───────────────────────────────────────────────────
  /** Read-only lookup of the original order behind a converted cart. Writes nothing, so it needs no lock and stays
   *  available without Web Locks (an unpaid order must stay payable). Never creates an order. */
  static async lookupConvertedCheckout(token: string): Promise<ConvertedLookup> {
    try {
      const { data } = await sellright().GET('/v1/shop/cart/{token}/checkout', { params: { path: { token } } });
      if (!data) return { ok: false, reason: 'unavailable' };
      return {
        ok: true,
        order: { code: data.code, state: data.state, grandTotal: data.grandTotal, receiptToken: data.receiptToken ?? '', currency: data.currency },
      };
    } catch (e) {
      if (e instanceof SellRightError && e.status === 404 && e.code === 'ORDER_NOT_FOUND') return { ok: false, reason: 'not_converted' };
      return { ok: false, reason: 'unavailable' };
    }
  }

  /**
   * Free the cart slot after the order behind it is finished. Under the lock: re-read the cookie (T), look up T's
   * original order, and retire T only when that order is settled or cancelled and — when `expectedCode` is given (a
   * confirmation page) — is the order that page shows. A failed lookup, `PendingPayment`, an unknown state, a code
   * mismatch or a 404 (T is a newer, non-converted cart) all keep the token. Returns whether T was retired.
   */
  static retireSettled(expectedCode?: string): Promise<boolean> {
    return this.exclusive(async () => {
      const token = this.readTokenCookie();
      if (!token) return false;
      const lookup = await this.lookupConvertedCheckout(token);
      if (!lookup.ok) return false;
      const kind = classifyOrderState(lookup.order.state);
      if (kind !== 'settled' && kind !== 'cancelled') return false;
      if (expectedCode !== undefined && lookup.order.code !== expectedCode) return false;
      this.retire(token);
      return true;
    });
  }

  /** Validate cart lines for checkout gating — fail-closed, live data only
   *  (the mirror is always the last server response; never cached). */
  static validateStock(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    for (const line of this.cart.lines) {
      if (line.available !== true) errors.push(`${line.name || line.sku}: Out of stock. Please remove from cart.`);
    }
    return { valid: errors.length === 0, errors };
  }
}
