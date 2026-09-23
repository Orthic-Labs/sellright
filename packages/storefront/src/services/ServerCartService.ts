/**
 * ServerCartService — server-authoritative cart for the SellRight REST shop API
 * (cart-architecture plan, Phase B). Mirrors the static surface that CartContext
 * already drives on LocalCartService (getCart / addItem / updateItemQuantity /
 * removeItem / clearCart) so the cart UI is swapped by a single flag with no
 * component changes.
 *
 * Contract (plan B1 + revision contract):
 *  - The opaque cart token lives in the `sr_cart` cookie (created lazily on first
 *    add via POST /v1/shop/cart).
 *  - `addItem` is a BLIND APPEND: the server increments the line's quantity and
 *    no base revision is needed — appends commute, so they can't stale-conflict.
 *  - `updateItemQuantity` / `removeItem` / `clearCart` / `captureEmail` / `merge`
 *    are NON-APPEND mutations: each must carry `expectedRevision` echoing
 *    `cart.revision`. A missing revision 409s 'revision_required'; a mismatched
 *    one 409s 'stale' + the current re-priced cart snapshot — adopted here so the
 *    mirror converges on the server's truth instead of fighting it.
 *  - Terminal carts ('converted' / 'merged') are rejected by every mutation; the
 *    client response is to discard the token + mirror, never to resurrect.
 *  - Each mutation: (1) apply optimistically to the in-memory + localStorage
 *    mirror and paint; (2) call the API; (3) on success REPLACE the mirror with
 *    the server-priced response (server wins on price/stock/coupon) and store
 *    the new revision; (4) on failure ROLL BACK to the last server snapshot and
 *    surface an error (a toast string on lastError) — or adopt the conflict
 *    snapshot when the server supplied one.
 *  - B0: on first op under the flag, if a legacy `vendure_local_cart` exists and
 *    there is no `sr_cart` token yet, seed a server cart from those lines and
 *    keep the legacy localStorage key (dormant) for lossless flag-OFF rollback.
 *
 * The server cart line carries no slug/image/options, which the cart UI needs
 * for product links + thumbnails. We therefore keep the client enrichment
 * (slug, image, options, isPreOrder, product name) in the mirror, keyed by SKU,
 * and merge the server's authoritative price/quantity/name back onto it.
 */
import type { LocalCart, LocalCartItem, StockValidationResult } from './LocalCartService';
import { LocalCartService } from './LocalCartService';
import {
  srCreateCart,
  srGetCart,
  srAddCartLines,
  srSetCartLines,
  srCaptureCartEmail,
  srMergeCart,
  srCartConflict,
  srErrorStatus,
  type SrCart,
  type SrCartLineInput,
} from '~/utils/sellright';

const CART_TOKEN_COOKIE = 'sr_cart';
const LEGACY_CART_KEY = 'vendure_local_cart';

export class ServerCartService {
  /** Optimistic mirror + last confirmed server snapshot (for rollback). */
  private static mirror: LocalCart | null = null;
  private static lastServerSnapshot: LocalCart | null = null;
  /** SKU → client enrichment (slug/image/options/preorder) the server doesn't return. */
  private static enrichment = new Map<string, LocalCartItem>();
  /** Last revision the server told us — required on every non-append mutation.
   *  Null on cold start (the persisted mirror carries no revision); the first
   *  revisioned mutation re-fetches the cart to learn it via ensureRevision(). */
  private static revision: number | null = null;
  /** Applied coupon code. The server evaluates coupons per-request (the cart
   *  row doesn't persist one) so every priced call must re-pass it or the
   *  discount silently drops on the next refresh/checkout. */
  private static couponCode: string | null = null;

  // ── token (sr_cart cookie) ────────────────────────────────────────────────
  private static getToken(): string | null {
    if (typeof document === 'undefined') return null;
    const m = document.cookie.match(new RegExp(`(?:^|; )${CART_TOKEN_COOKIE}=([^;]*)`));
    return m ? decodeURIComponent(m[1]) : null;
  }

  private static setToken(token: string): void {
    if (typeof document === 'undefined') return;
    const secure = typeof location !== 'undefined' && location.protocol === 'https:' ? '; Secure' : '';
    // 30-day TTL mirrors the server CART_TTL_DAYS default.
    document.cookie = `${CART_TOKEN_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${30 * 24 * 60 * 60}; SameSite=Lax${secure}`;
  }

  private static clearToken(): void {
    if (typeof document === 'undefined') return;
    document.cookie = `${CART_TOKEN_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
  }

  // ── empty / mirror helpers ────────────────────────────────────────────────
  private static empty(): LocalCart {
    return {
      items: [],
      totalQuantity: 0,
      subTotal: 0,
      currencyCode: 'USD',
      countryCode: LocalCartService.getCountry(),
      countryExplicitlySet: LocalCartService.hasExplicitCountrySelection(),
      appliedCoupon: null,
    };
  }

  /** Read the current mirror — in-memory, falling back to the persisted copy. */
  static getCart(): LocalCart {
    if (this.mirror) return this.mirror;
    // The mirror is persisted to the legacy key so the header badge
    // (getCartQuantityFromStorage) and cross-tab sync keep working unchanged.
    const persisted = LocalCartService.getCart();
    this.mirror = persisted;
    if (!this.lastServerSnapshot) this.lastServerSnapshot = persisted;
    this.rebuildEnrichmentFromMirror(persisted);
    return persisted;
  }

  private static rebuildEnrichmentFromMirror(cart: LocalCart): void {
    for (const it of cart.items) {
      const sku = (it as any).sku ?? it.productVariant.id;
      this.enrichment.set(sku, it);
    }
  }

  /** Persist the mirror to memory + the legacy localStorage key (server-priced). */
  private static commitMirror(cart: LocalCart): void {
    this.mirror = cart;
    // saveCart triggers the cross-tab callbacks + cache the UI already relies on.
    LocalCartService.saveCart(cart);
    this.notify(cart.totalQuantity);
  }

  private static notify(totalQuantity: number): void {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('cart-updated', { detail: { totalQuantity } }));
    }
  }

  /** Adopt a server cart: store its revision and return the mirror form. */
  private static adoptServer(server: SrCart): LocalCart {
    this.revision = server.revision;
    return this.toMirror(server);
  }

  // ── SrCart → LocalCart mirror (server wins, enrichment merged back) ────────
  private static toMirror(server: SrCart): LocalCart {
    const items: LocalCartItem[] = server.lines.map((line) => {
      const prior = this.enrichment.get(line.sku);
      const item: LocalCartItem = {
        productVariantId: prior?.productVariantId ?? line.sku,
        quantity: line.quantity,
        isPreOrder: prior?.isPreOrder,
        shipDate: prior?.shipDate,
        // unitPrice is the server's authoritative selected price (cents).
        salePrice: undefined,
        preOrderPrice: undefined,
        lastStockCheck: Date.now(),
        productVariant: {
          id: prior?.productVariant.id ?? line.sku,
          name: line.name || prior?.productVariant.name || line.sku,
          price: line.unitPrice,
          stockLevel: line.available ? '999' : '0',
          product: prior?.productVariant.product ?? { id: line.sku, name: line.name, slug: '' },
          options: prior?.productVariant.options ?? [],
          featuredAsset: prior?.productVariant.featuredAsset ?? null,
        },
      };
      // Keep sku addressable for enrichment lookups across reconciles.
      (item as any).sku = line.sku;
      return item;
    });

    const cart: LocalCart = {
      items,
      totalQuantity: items.reduce((a, i) => a + i.quantity, 0),
      // subTotal here is the line subtotal (pre-discount) to match LocalCart semantics;
      // the cart footer applies coupon/shipping on top of subTotal exactly as before.
      subTotal: server.subtotal,
      currencyCode: server.currency,
      countryCode: this.mirror?.countryCode ?? LocalCartService.getCountry(),
      countryExplicitlySet: this.mirror?.countryExplicitlySet ?? LocalCartService.hasExplicitCountrySelection(),
      appliedCoupon: server.coupon?.applied
        ? {
            code: server.coupon.code,
            discountAmount: server.discountTotal,
            freeShipping: false,
          }
        : null,
    };
    // refresh enrichment from the merged items
    this.rebuildEnrichmentFromMirror(cart);
    return cart;
  }

  /** Absolute line inputs derived from the current mirror (for revisioned SET). */
  private static linesFromMirror(cart: LocalCart): SrCartLineInput[] {
    return cart.items.map((it) => ({ sku: (it as any).sku ?? it.productVariant.id, quantity: it.quantity }));
  }

  // ── B0: ensure a server cart exists (seed from legacy local cart, keep key) ─
  private static async ensureCart(): Promise<string> {
    let token = this.getToken();
    if (token) return token;

    // No token yet — seed from the legacy local cart if present (B0). The legacy
    // key is NOT deleted: a flag-OFF rollback must restore the local cart.
    const legacy = LocalCartService.getCart();
    const seed: SrCartLineInput[] = legacy.items
      .filter((i) => i.quantity > 0)
      .map((i) => ({ sku: (i as any).sku ?? i.productVariant.id, quantity: i.quantity }));
    // capture enrichment from the legacy cart so links/images survive the swap
    this.rebuildEnrichmentFromMirror(legacy);

    const server = await srCreateCart({ ...(seed.length ? { items: seed } : {}), ...(this.couponCode ? { couponCode: this.couponCode } : {}) });
    token = server.token;
    this.setToken(token);
    const mirror = this.adoptServer(server);
    this.lastServerSnapshot = mirror;
    this.commitMirror(mirror);
    return token;
  }

  /** Learn the current revision before a non-append mutation (cold start). */
  private static async ensureRevision(token: string): Promise<number | null> {
    if (this.revision != null) return this.revision;
    try {
      const server = await srGetCart(token, this.couponCode ?? undefined);
      const mirror = this.adoptServer(server);
      this.lastServerSnapshot = mirror;
      this.commitMirror(mirror);
      return this.revision;
    } catch (error) {
      if (srErrorStatus(error) === 404) this.discardLocal();
      return null;
    }
  }

  /**
   * Handle a mutation failure. 409 conflicts carry the server's current
   * revision + re-priced snapshot — adopt it so the mirror converges. Terminal
   * carts (converted/merged) and 404s retire the token + mirror outright.
   * Returns the toast string to surface.
   */
  private static reconcileMutationError(error: unknown): string {
    const conflict = srCartConflict(error);
    if (conflict) {
      if (conflict.code === 'converted' || conflict.code === 'merged') {
        // Terminal cart — its lines already became an order (or moved into the
        // customer's cart at merge). Discarding is the only correct response.
        this.discardLocal();
        return conflict.code === 'converted'
          ? 'This cart was already checked out'
          : 'This cart was merged into your account cart';
      }
      // stale / revision_required — adopt the authoritative snapshot so the
      // next attempt starts from the server's truth.
      this.revision = conflict.revision;
      const adopted = this.toMirror(conflict.cart);
      this.lastServerSnapshot = adopted;
      this.commitMirror(adopted);
      return 'Cart changed — review the updated cart and try again';
    }
    if (srErrorStatus(error) === 404) {
      this.discardLocal();
      return 'Your cart expired — please re-add your items';
    }
    this.commitMirror(this.lastServerSnapshot ?? this.empty());
    return this.toastMessage(error);
  }

  /** Drop the token, mirror, and revision without a network call. */
  static discardLocal(): void {
    this.clearToken();
    this.revision = null;
    this.couponCode = null;
    this.lastServerSnapshot = null;
    this.enrichment.clear();
    this.commitMirror(this.empty());
  }

  /** Fresh server cart for checkout: re-reads so expectedRevision is the live
   *  base (conversion is a non-append mutation). Null when no cart exists.
   *  `status` lets the caller distinguish 'converted' (the server replays the
   *  original order — payment recovery) from 'merged' (unusable — discard). */
  static async checkoutSnapshot(): Promise<{ token: string; revision: number; status: string } | null> {
    const token = this.getToken();
    if (!token) return null;
    try {
      const server = await srGetCart(token, this.couponCode ?? undefined);
      const mirror = this.adoptServer(server);
      this.lastServerSnapshot = mirror;
      this.commitMirror(mirror);
      return { token, revision: server.revision, status: server.status };
    } catch (error) {
      if (srErrorStatus(error) === 404) this.discardLocal();
      return null;
    }
  }

  /** Adopt a cart snapshot handed back inside a 409 (checkout stale-cart). */
  static adoptConflictCart(cart: SrCart): void {
    const mirror = this.adoptServer(cart);
    this.lastServerSnapshot = mirror;
    this.commitMirror(mirror);
  }

  // ── mutations ──────────────────────────────────────────────────────────────

  /**
   * Add (or increment) an item. The optimistic mirror is painted immediately,
   * then PATCHed as a BLIND APPEND (server increments — no revision needed) and
   * replaced by the server-priced response; on failure it rolls back.
   */
  static async addItem(item: LocalCartItem): Promise<{ cart: LocalCart; stockResult: StockValidationResult }> {
    const sku = (item as any).sku ?? item.productVariant.id;
    this.enrichment.set(sku, item);

    const current = this.getCart();
    this.lastServerSnapshot = current;

    // optimistic: compute resulting absolute quantity for the paint
    const existing = current.items.find((i) => ((i as any).sku ?? i.productVariant.id) === sku);
    const resultingQty = (existing?.quantity ?? 0) + item.quantity;
    const optimistic = this.applyOptimistic(current, item, resultingQty);
    this.commitMirror(optimistic);

    try {
      const token = await this.ensureCart();
      const server = await srAddCartLines(token, [{ sku, quantity: item.quantity }], this.couponCode ?? undefined);
      const reconciled = this.adoptServer(server);
      this.lastServerSnapshot = reconciled;
      this.commitMirror(reconciled);
      const line = server.lines.find((l) => l.sku === sku);
      return {
        cart: reconciled,
        stockResult: { success: !!line?.available, availableStock: line?.available ? 999 : 0,
          error: line && !line.available ? 'Item is no longer available' : undefined },
      };
    } catch (error) {
      return {
        cart: this.mirror!,
        stockResult: { success: false, availableStock: 0, error: this.reconcileMutationError(error) },
      };
    }
  }

  /** Set an item to an absolute quantity (0 removes). Non-append mutation —
   *  requires the current revision; a stale base adopts the server snapshot. */
  static async updateItemQuantity(productVariantId: string, quantity: number): Promise<{ cart: LocalCart; stockResult: StockValidationResult }> {
    const current = this.getCart();
    this.lastServerSnapshot = current;

    const sku = this.skuForVariant(current, productVariantId);
    const optimistic = this.setQuantity(current, sku, quantity);
    this.commitMirror(optimistic);

    try {
      const token = await this.ensureCart();
      const revision = await this.ensureRevision(token);
      if (revision == null) throw new Error('cart unavailable');
      // Absolute SET touches only the lines sent — a removed SKU must be sent
      // explicitly as quantity 0 or the server leaves the row in place.
      const setLines = this.linesFromMirror(optimistic);
      if (quantity <= 0) setLines.push({ sku, quantity: 0 });
      const server = await srSetCartLines(token, setLines, revision, this.couponCode ?? undefined);
      const reconciled = this.adoptServer(server);
      this.lastServerSnapshot = reconciled;
      this.commitMirror(reconciled);
      const line = server.lines.find((l) => l.sku === sku);
      return {
        cart: reconciled,
        stockResult: { success: true, availableStock: line?.available ? 999 : 0 },
      };
    } catch (error) {
      return { cart: this.mirror!, stockResult: { success: false, availableStock: 0, error: this.reconcileMutationError(error) } };
    }
  }

  /** Remove an item (absolute quantity 0). */
  static async removeItem(productVariantId: string): Promise<LocalCart> {
    const res = await this.updateItemQuantity(productVariantId, 0);
    return res.cart;
  }

  /** Clear every line (revisioned absolute set). Keeps the cart token. */
  static async clearCart(): Promise<LocalCart> {
    const current = this.getCart();
    this.lastServerSnapshot = current;
    if (current.items.length === 0) {
      const empty = this.empty();
      this.commitMirror(empty);
      return empty;
    }
    const optimistic = this.empty();
    this.commitMirror(optimistic);
    try {
      const token = this.getToken();
      if (token) {
        const revision = await this.ensureRevision(token);
        if (revision == null) throw new Error('cart unavailable');
        const server = await srSetCartLines(
          token,
          current.items.map((i) => ({ sku: (i as any).sku ?? i.productVariant.id, quantity: 0 })),
          revision,
          this.couponCode ?? undefined,
        );
        const reconciled = this.adoptServer(server);
        this.lastServerSnapshot = reconciled;
        this.commitMirror(reconciled);
        return reconciled;
      }
      return optimistic;
    } catch (error) {
      console.error('[ServerCartService] clearCart failed:', error);
      this.reconcileMutationError(error);
      return this.mirror!;
    }
  }

  /** Re-fetch the server-priced cart (server wins) — used by stock refresh. */
  static async refresh(): Promise<LocalCart> {
    const token = this.getToken();
    if (!token) return this.getCart();
    try {
      const server = await srGetCart(token, this.couponCode ?? undefined);
      const reconciled = this.adoptServer(server);
      this.lastServerSnapshot = reconciled;
      this.commitMirror(reconciled);
      return reconciled;
    } catch (error) {
      if (srErrorStatus(error) === 404) return this.discardLocal(), this.getCart();
      console.error('[ServerCartService] refresh failed:', error);
      return this.getCart();
    }
  }

  /**
   * Validate + apply a coupon code. The server evaluates the code against the
   * cart's real lines and returns `coupon.applied` + the re-priced discount —
   * the mirror is updated from that response, never from a client guess.
   * Replaces the Vendure `validateLocalCartCouponQuery` on the SR path.
   */
  static async applyCoupon(code: string): Promise<{ valid: boolean; reason?: string }> {
    const token = await this.ensureCart();
    const server = await srGetCart(token, code);
    if (server.coupon?.applied) {
      this.couponCode = server.coupon.code;
      const mirror = this.adoptServer(server);
      this.lastServerSnapshot = mirror;
      this.commitMirror(mirror);
      return { valid: true };
    }
    // Not applied — adopt the repriced cart anyway (server truth), keep the
    // prior coupon state, and surface the server's reason.
    const mirror = this.adoptServer(server);
    this.lastServerSnapshot = mirror;
    this.commitMirror(mirror);
    return { valid: false, reason: server.coupon?.reason ?? 'Invalid or expired code' };
  }

  /** Remove the applied coupon — re-price without the code and adopt. */
  static async removeCoupon(): Promise<void> {
    this.couponCode = null;
    const token = this.getToken();
    if (!token) return;
    try {
      const server = await srGetCart(token);
      const mirror = this.adoptServer(server);
      this.lastServerSnapshot = mirror;
      this.commitMirror(mirror);
    } catch (error) {
      if (srErrorStatus(error) === 404) this.discardLocal();
    }
  }

  /** Capture the shopper's email on the cart (abandoned-cart recovery). */
  static async captureEmail(email: string): Promise<void> {
    const token = this.getToken();
    if (!token) return;
    try {
      const revision = await this.ensureRevision(token);
      if (revision == null) return;
      const server = await srCaptureCartEmail(token, email, revision);
      this.commitMirror(this.adoptServer(server));
    } catch (error) {
      this.reconcileMutationError(error);
      console.error('[ServerCartService] captureEmail failed:', error);
    }
  }

  /** Merge the guest cart into the logged-in customer (call after auth). */
  static async merge(): Promise<void> {
    const token = this.getToken();
    if (!token) return;
    try {
      const revision = await this.ensureRevision(token);
      if (revision == null) return;
      const server = await srMergeCart(token, revision);
      const reconciled = this.adoptServer(server);
      this.lastServerSnapshot = reconciled;
      this.commitMirror(reconciled);
    } catch (error) {
      this.reconcileMutationError(error);
      console.error('[ServerCartService] merge failed:', error);
    }
  }

  // ── pure optimistic helpers ────────────────────────────────────────────────
  private static skuForVariant(cart: LocalCart, productVariantId: string): string {
    const found = cart.items.find((i) => i.productVariantId === productVariantId);
    return (found as any)?.sku ?? productVariantId;
  }

  private static applyOptimistic(cart: LocalCart, item: LocalCartItem, resultingQty: number): LocalCart {
    const sku = (item as any).sku ?? item.productVariant.id;
    const items = [...cart.items];
    const idx = items.findIndex((i) => ((i as any).sku ?? i.productVariant.id) === sku);
    const next: LocalCartItem = { ...item, quantity: resultingQty };
    (next as any).sku = sku;
    if (idx >= 0) items[idx] = next;
    else items.push(next);
    return this.recalc({ ...cart, items });
  }

  private static setQuantity(cart: LocalCart, sku: string, quantity: number): LocalCart {
    let items = cart.items.map((i) =>
      ((i as any).sku ?? i.productVariant.id) === sku ? { ...i, quantity } : i,
    );
    items = items.filter((i) => i.quantity > 0);
    return this.recalc({ ...cart, items });
  }

  private static recalc(cart: LocalCart): LocalCart {
    const totalQuantity = cart.items.reduce((a, i) => a + i.quantity, 0);
    const subTotal = cart.items.reduce((a, i) => a + LocalCartService.lineUnitPrice(i) * i.quantity, 0);
    return { ...cart, totalQuantity, subTotal };
  }

  private static toastMessage(error: unknown): string {
    const msg = error instanceof Error ? error.message : String(error);
    return msg.includes('409') ? "Couldn't update cart — some items are unavailable" : "Couldn't update cart";
  }

  /** Mirror LocalCartService.validateStock for checkout gating. */
  static validateStock(): { valid: boolean; errors: string[] } {
    const cart = this.getCart();
    const errors: string[] = [];
    for (const item of cart.items) {
      const stockLevel = parseInt(item.productVariant.stockLevel || '0');
      if (stockLevel <= 0) errors.push(`${item.productVariant.name}: Out of stock. Please remove from cart.`);
    }
    return { valid: errors.length === 0, errors };
  }
}

/** Marker re-export so consumers can detect the legacy key is preserved (B0). */
export const LEGACY_LOCAL_CART_KEY = LEGACY_CART_KEY;
