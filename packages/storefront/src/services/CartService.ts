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
 * See `~/sellright/types/cart.ts` for the full API contract, the native
 * Cart/CartLine types, and the fail-closed stock rules.
 */
import { sellright, SellRightError } from '~/sellright/client';
import {
  EMPTY_CART,
  type Cart,
  type CartLine,
  type CartLineEnrichment,
  type CartConflict,
  type CartMutationResult,
  type ServerCart,
} from '~/sellright/types/cart';

const TOKEN_COOKIE = 'sr_cart';
/** Pre-native cart key, read exactly once for a lossless one-time migration. */
const LEGACY_CART_KEY = 'sellright_legacy_local_cart';

export class CartError extends Error {
  constructor(
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'CartError';
  }
}

type LegacySeedLine = { sku: string; quantity: number; enrichment: CartLineEnrichment };

export class CartService {
  private static cart: Cart = EMPTY_CART;
  private static couponCode: string | null = null;
  private static enrichment = new Map<string, CartLineEnrichment>();
  private static listeners = new Set<() => void>();

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

  // ── read accessors ───────────────────────────────────────────────────
  static getCart(): Cart {
    return this.cart;
  }

  static token(): string | null {
    return this.cart.token || this.readTokenCookie();
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

  // ── enrichment (client-only display metadata, keyed by SKU) ─────────────
  private static setEnrichment(sku: string, enrichment?: CartLineEnrichment): void {
    if (!enrichment) return;
    this.enrichment.set(sku, { ...this.enrichment.get(sku), ...enrichment });
  }

  private static toCartLine = (line: ServerCart['lines'][number]): CartLine => ({
    ...line,
    ...this.enrichment.get(line.sku),
  });

  private static toCart(server: ServerCart): Cart {
    return { ...server, lines: server.lines.map(this.toCartLine) };
  }

  // ── adopt a server snapshot; report SKUs that vanished unexpectedly ──────
  private static adopt(server: ServerCart, expectedRemoval?: string): string[] {
    const prior = new Set(this.cart.lines.map((l) => l.sku));
    const next = new Set(server.lines.map((l) => l.sku));
    const dropped = [...prior].filter((sku) => sku !== expectedRemoval && !next.has(sku));
    this.cart = this.toCart(server);
    this.writeTokenCookie(server.token);
    // Keep enrichment only for lines still present — stale entries would leak
    // display metadata onto an unrelated future line that reuses the SKU.
    for (const sku of [...this.enrichment.keys()]) {
      if (!next.has(sku)) this.enrichment.delete(sku);
    }
    this.notify();
    return dropped;
  }

  /** Drop the token + mirror locally — no network call. Used for terminal
   *  carts (converted/merged) and 404s (expired cart). */
  static discard(): void {
    this.clearTokenCookie();
    this.couponCode = null;
    this.enrichment.clear();
    this.cart = EMPTY_CART;
    this.notify();
  }

  /** Adopt a cart snapshot handed back inside a checkout 409 (stale cart). */
  static adoptConflict(cart: ServerCart): void {
    this.adopt(cart);
  }

  // ── one-time legacy migration ────────────────────────────────────────
  /** Reads the pre-native `sellright_legacy_local_cart` key exactly once, converts its
   *  lines to `{ sku, quantity }` by SKU, carries over its display
   *  enrichment, and deletes the key immediately — deleting it is what makes
   *  this single-shot: no key means nothing left to migrate, ever again. */
  private static consumeLegacyCart(): LegacySeedLine[] {
    if (typeof window === 'undefined') return [];
    let raw: string | null;
    try {
      raw = localStorage.getItem(LEGACY_CART_KEY);
    } catch {
      return [];
    }
    if (!raw) return [];
    try {
      localStorage.removeItem(LEGACY_CART_KEY);
    } catch {
      /* best-effort cleanup — a stuck key just gets migrated again, harmlessly */
    }
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    const items: any[] = Array.isArray(parsed?.items) ? parsed.items : [];
    const seen = new Set<string>();
    const lines: LegacySeedLine[] = [];
    for (const item of items) {
      const sku: string | undefined = item?.sku ?? item?.productVariantId ?? item?.productVariant?.id;
      const quantity = Number(item?.quantity);
      if (!sku || seen.has(sku) || !Number.isFinite(quantity) || quantity <= 0) continue;
      seen.add(sku);
      lines.push({
        sku,
        quantity,
        enrichment: {
          slug: item?.productVariant?.product?.slug,
          image: item?.productVariant?.featuredAsset?.preview ?? null,
          name: item?.productVariant?.name,
          isPreOrder: !!item?.isPreOrder,
          shipDate: item?.shipDate,
        },
      });
    }
    return lines;
  }

  // ── cart lifecycle ────────────────────────────────────────────────────
  private static async ensureCart(): Promise<string> {
    const existing = this.readTokenCookie();
    if (existing) return existing;

    const legacy = this.consumeLegacyCart();
    for (const l of legacy) this.setEnrichment(l.sku, l.enrichment);

    const { data } = await sellright().POST('/v1/shop/cart', {
      body: legacy.length ? { items: legacy.map(({ sku, quantity }) => ({ sku, quantity })) } : {},
    });
    if (!data) throw new CartError(undefined, 'Could not create a cart');
    this.adopt(data);
    return data.token;
  }

  /** Ensure the mirror's revision is live (cold start reads it via GET). */
  private static async ensureRevision(token: string): Promise<number> {
    if (this.cart.token === token && this.cart.revision) return this.cart.revision;
    const { data } = await sellright().GET('/v1/shop/cart/{token}', {
      params: { path: { token }, query: this.couponCode ? { couponCode: this.couponCode } : {} },
    });
    if (!data) throw new CartError('not_found', 'Cart not found');
    this.adopt(data);
    return data.revision;
  }

  private static asConflict(e: unknown): CartConflict | null {
    if (!(e instanceof SellRightError) || e.status !== 409) return null;
    const body = e.body as CartConflict | undefined;
    return body && typeof body.revision === 'number' && body.cart ? body : null;
  }

  /** Run a revisioned mutation; on a 409 adopt the server's snapshot and
   *  retry exactly once with the fresh revision. Never loops further. */
  private static async withRevisionRetry(
    mutate: (token: string, revision: number) => Promise<{ data?: ServerCart }>,
    expectedRemoval?: string,
  ): Promise<CartMutationResult> {
    const token = await this.ensureCart();
    const revision = await this.ensureRevision(token);
    try {
      const { data } = await mutate(token, revision);
      if (!data) throw new CartError(undefined, "Couldn't update cart");
      const dropped = this.adopt(data, expectedRemoval);
      return { cart: this.cart, dropped };
    } catch (e) {
      const conflict = this.asConflict(e);
      if (conflict) {
        if (conflict.code === 'converted' || conflict.code === 'merged') {
          this.discard();
          throw new CartError(
            conflict.code,
            conflict.code === 'converted' ? 'This cart was already checked out' : 'This cart was merged into your account',
          );
        }
        // stale / revision_required — adopt the authoritative snapshot, retry once.
        this.adopt(conflict.cart, expectedRemoval);
        try {
          const { data } = await mutate(token, conflict.revision);
          if (!data) throw new CartError(undefined, "Couldn't update cart");
          const dropped = this.adopt(data, expectedRemoval);
          return { cart: this.cart, dropped };
        } catch (e2) {
          if (e2 instanceof SellRightError && e2.status === 404) this.discard();
          throw new CartError('conflict', 'Cart changed — review the updated cart and try again');
        }
      }
      if (e instanceof SellRightError && e.status === 404) {
        this.discard();
        throw new CartError('not_found', 'Your cart expired — please re-add your items');
      }
      throw e;
    }
  }

  // ── mutations ─────────────────────────────────────────────────────────

  /** Add (or increment) a line. Blind append — commutative, no revision. */
  static async addLine(sku: string, quantity: number, enrichment?: CartLineEnrichment): Promise<CartMutationResult> {
    this.setEnrichment(sku, enrichment);
    try {
      const token = await this.ensureCart();
      const { data } = await sellright().PATCH('/v1/shop/cart/{token}/lines', {
        params: { path: { token } },
        body: { lines: [{ sku, quantity }], ...(this.couponCode ? { couponCode: this.couponCode } : {}) },
      });
      if (!data) throw new CartError(undefined, "Couldn't add item to cart");
      const dropped = this.adopt(data);
      return { cart: this.cart, dropped };
    } catch (e) {
      if (e instanceof SellRightError && e.status === 404) {
        this.discard();
        throw new CartError('not_found', 'Your cart expired — please re-add your items');
      }
      throw e;
    }
  }

  /** Set a line to an absolute quantity (<= 0 removes it). Revisioned. */
  static async updateLine(sku: string, quantity: number, enrichment?: CartLineEnrichment): Promise<CartMutationResult> {
    this.setEnrichment(sku, enrichment);
    const qty = Math.max(0, quantity);
    return this.withRevisionRetry(
      (token, revision) =>
        sellright().PATCH('/v1/shop/cart/{token}/lines', {
          params: { path: { token } },
          body: {
            lines: [{ sku, quantity: qty }],
            expectedRevision: revision,
            ...(this.couponCode ? { couponCode: this.couponCode } : {}),
          },
        }),
      qty <= 0 ? sku : undefined,
    );
  }

  /** Remove a line entirely — sugar for `updateLine(sku, 0)`. */
  static async removeLine(sku: string): Promise<CartMutationResult> {
    return this.updateLine(sku, 0);
  }

  /** Re-fetch the server-priced cart (live stock/price/coupon) — used for the
   *  LOCKED stock checks: cart open, checkout entry, and pre-submit. */
  static async refresh(): Promise<CartMutationResult> {
    const token = this.readTokenCookie();
    if (!token) return { cart: this.cart, dropped: [] };
    try {
      const { data } = await sellright().GET('/v1/shop/cart/{token}', {
        params: { path: { token }, query: this.couponCode ? { couponCode: this.couponCode } : {} },
      });
      if (!data) throw new CartError('not_found', 'Cart not found');
      const dropped = this.adopt(data);
      return { cart: this.cart, dropped };
    } catch (e) {
      if (e instanceof SellRightError && e.status === 404) {
        this.discard();
        return { cart: this.cart, dropped: [] };
      }
      throw e;
    }
  }

  /** Validate + apply a coupon — the server re-prices the real cart; never a
   *  client-side guess. */
  static async applyCoupon(code: string): Promise<{ valid: boolean; reason?: string }> {
    const token = await this.ensureCart();
    const { data } = await sellright().GET('/v1/shop/cart/{token}', { params: { path: { token }, query: { couponCode: code } } });
    if (!data) throw new CartError('not_found', 'Cart not found');
    this.adopt(data);
    if (data.coupon?.applied) {
      this.couponCode = data.coupon.code;
      return { valid: true };
    }
    return { valid: false, reason: data.coupon?.reason ?? 'Invalid or expired code' };
  }

  /** Remove the applied coupon and re-price without it. */
  static async removeCoupon(): Promise<CartMutationResult> {
    this.couponCode = null;
    const token = this.readTokenCookie();
    if (!token) return { cart: this.cart, dropped: [] };
    try {
      const { data } = await sellright().GET('/v1/shop/cart/{token}', { params: { path: { token } } });
      if (!data) throw new CartError('not_found', 'Cart not found');
      const dropped = this.adopt(data);
      return { cart: this.cart, dropped };
    } catch (e) {
      if (e instanceof SellRightError && e.status === 404) {
        this.discard();
        return { cart: this.cart, dropped: [] };
      }
      throw e;
    }
  }

  /** Capture the shopper's email on the cart (abandoned-cart recovery). */
  static async captureEmail(email: string): Promise<CartMutationResult> {
    return this.withRevisionRetry((token, revision) =>
      sellright().PATCH('/v1/shop/cart/{token}', {
        params: { path: { token } },
        body: { email, expectedRevision: revision },
      }),
    );
  }

  /** Fold the guest cart into the logged-in customer. Call once, after auth. */
  static async merge(): Promise<CartMutationResult> {
    return this.withRevisionRetry((token, revision) =>
      sellright().POST('/v1/shop/cart/{token}/merge', {
        params: { path: { token }, query: { expectedRevision: revision } },
      }),
    );
  }

  /** Fresh server cart for checkout: re-reads so `expectedRevision` is the
   *  live base. `null` when no cart exists. `status` distinguishes
   *  'converted' (replay the original order — payment recovery) from
   *  'merged' (terminal — discard). */
  static async checkoutSnapshot(): Promise<{ token: string; revision: number; status: string } | null> {
    const token = this.readTokenCookie();
    if (!token) return null;
    try {
      const { data } = await sellright().GET('/v1/shop/cart/{token}', {
        params: { path: { token }, query: this.couponCode ? { couponCode: this.couponCode } : {} },
      });
      if (!data) return null;
      this.adopt(data);
      return { token, revision: data.revision, status: data.status };
    } catch (e) {
      if (e instanceof SellRightError && e.status === 404) this.discard();
      return null;
    }
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
