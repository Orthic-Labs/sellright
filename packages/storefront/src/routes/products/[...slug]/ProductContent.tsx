import { $, component$, useComputed$, useContext, useOnDocument, useSignal, useStore, useTask$ } from '@qwik.dev/core';
import { APP_STATE } from '~/constants';
import { getProductStock } from '~/providers/shop/products/products';
import { mergeProductStock, type CatalogProduct, type CatalogVariant } from '~/sellright/types/catalog';
import type { CartLineEnrichment } from '~/sellright/types/cart';
import { useCart, addToCart } from '~/contexts/CartContext';
import { loadCountryOnDemand } from '~/utils/addressStorage';
import { useImageGalleryTouchHandling } from '~/utils/optimized-touch-handling';
import { ProductPageView } from './ProductPageView';
import { findVariant, getOptionGroups } from './product-options';
import type { ProductLoaderResult } from './index';

/** One gallery image — native shape (no Vendure `Asset` object, no `id`;
 *  images are matched by `preview` URL, which is unique within a product). */
export interface GalleryImage {
  preview: string;
}

const PLACEHOLDER_IMAGE: GalleryImage = { preview: '/asset_placeholder.webp' };

/** Cart boundary: translate the native product/variant into the cart's
 *  client-only display enrichment (`~/sellright/types/cart`). This is the
 *  ONLY place in the catalog area that builds it — everything upstream of it
 *  stays native, and the server cart line itself carries only `sku`/`quantity`. */
function toCartEnrichment(product: CatalogProduct, variant: CatalogVariant, image: GalleryImage | undefined): CartLineEnrichment {
  return {
    slug: product.slug,
    image: image?.preview ?? null,
    name: variant.name,
    options: variant.options.map((o) => o.name).join(' / '),
    isPreOrder: variant.isPreOrder,
    shipDate: variant.shipDate ?? undefined,
  };
}

export const ProductContent = component$(({ loaderResult }: { loaderResult: ProductLoaderResult | { failed: true; message?: string } | null | undefined }) => {
  const appState = useContext(APP_STATE);
  const cart = useCart();
  if (!loaderResult || 'failed' in loaderResult || !('product' in loaderResult) || !loaderResult.product) {
    return (
      <div class="min-h-[50vh] flex flex-col items-center justify-center py-16 px-4">
        <h1 class="text-2xl font-bold text-gray-900 mb-3">Product Not Found</h1>
        <p class="text-gray-500 mb-6">This product may have been discontinued or is no longer available.</p>
        <a href="/shop" class="inline-flex items-center px-6 py-2.5 bg-black text-white text-sm font-medium uppercase tracking-wider hover:bg-gray-800 transition-colors">Browse Products</a>
      </div>
    );
  }
  const product = useStore(loaderResult.product);
  if (!product || !product.variants || product.variants.length === 0) {
    return <div class="text-center py-8">Product not found</div>;
  }
  const isEnhancing = useSignal(false);
  const enhancementError = useSignal<string | null>(null);
  const galleryImages: GalleryImage[] = product.images.length ? product.images.map((preview) => ({ preview })) : [PLACEHOLDER_IMAGE];
  const currentImageSig = useSignal<GalleryImage>(galleryImages[0]);
  const currentImageIndex = useSignal(0);
  const groups = useComputed$(() => getOptionGroups(product.variants));
  const selectedValues = useSignal<(string | null)[]>([]);
  const hasVariantAssets = product.variants.some((v) => (v.assets?.length || 0) > 0);
  const baseGalleryList: GalleryImage[] = galleryImages;
  const orderedAssets = useSignal<GalleryImage[]>(baseGalleryList);
  const showImageModal = useSignal(false);
  const modalImageSrc = useSignal('');
  const isImageLoading = useSignal(false);
  const modalImageIndex = useSignal(0);
  const openImageModal = $((imageSrc: string, imageIndex?: number) => {
    modalImageSrc.value = imageSrc;
    modalImageIndex.value = imageIndex ?? orderedAssets.value.findIndex(
      (a) => a.preview === imageSrc.replace(/\?preset=modal$/, ''),
    );
    showImageModal.value = true;
    isImageLoading.value = true;
    setTimeout(() => { isImageLoading.value = false; }, 150);
    document.body.style.overflow = 'hidden';
  });
  const closeImageModal = $(() => {
    showImageModal.value = false;
    modalImageSrc.value = '';
    isImageLoading.value = false;
    document.body.style.overflow = 'unset';
  });
  const navigateModal = $((direction: 'prev' | 'next') => {
    const len = orderedAssets.value.length;
    const newIndex = direction === 'next'
      ? (modalImageIndex.value + 1) % len
      : (modalImageIndex.value - 1 + len) % len;
    const newAsset = orderedAssets.value[newIndex];
    modalImageIndex.value = newIndex;
    modalImageSrc.value = newAsset.preview.includes('asset_placeholder')
      ? newAsset.preview : newAsset.preview + '?preset=modal';
    isImageLoading.value = true;
    setTimeout(() => { isImageLoading.value = false; }, 150);
    currentImageSig.value = newAsset;
  });
  const handleGroupSelect$ = $((e: Event) => {
    const btn = (e.target as HTMLElement).closest('[data-group-name]') as HTMLElement;
    if (!btn) return;
    const name = btn.dataset.groupName!;
    const val = btn.dataset.val!;
    const isReset = btn.dataset.reset === '1';
    const idx = groups.value.findIndex(g => g.groupName === name);
    if (isReset) {
      const next = Array(groups.value.length).fill(null);
      next[idx] = val;
      selectedValues.value = next;
    } else {
      const next = [...selectedValues.value];
      next[idx] = val;
      selectedValues.value = next;
    }
    if (idx === 0 && hasVariantAssets) {
      const firstGroupName = groups.value[0]?.groupName;
      const firstSel = val;
      let list: GalleryImage[] = baseGalleryList;
      if (firstGroupName && firstSel) {
        const seen = new Set<string>();
        const union: GalleryImage[] = [];
        for (const v of product.variants) {
          const match = v.options?.some(
            (o) => o.group?.name === firstGroupName && o.name === firstSel,
          );
          if (!match) continue;
          for (const a of (v.assets || [])) {
            if (a?.preview && !seen.has(a.preview)) {
              seen.add(a.preview);
              union.push(a);
            }
          }
        }
        if (union.length > 0) list = union;
      }
      orderedAssets.value = list;
      currentImageSig.value = list[0];
      currentImageIndex.value = 0;
    }
  });
  useOnDocument('keydown', $((event: Event) => {
    const e = event as KeyboardEvent;
    if (!showImageModal.value) return;
    switch (e.key) {
      case 'Escape': closeImageModal(); break;
      case 'ArrowLeft': if (orderedAssets.value.length > 1) navigateModal('prev'); break;
      case 'ArrowRight': if (orderedAssets.value.length > 1) navigateModal('next'); break;
    }
  }));
  const refreshLiveStock = $(async () => {
    isEnhancing.value = true;
    enhancementError.value = null;
    try {
      const stock = await getProductStock(product.slug);
      if (!stock) return;
      const merged = mergeProductStock(product, stock);
      product.variants = merged.variants;
      const isCompleteSelection =
        groups.value.length > 0 &&
        selectedValues.value.length === groups.value.length &&
        selectedValues.value.every(v => v !== null);
      if (isCompleteSelection) {
        const resolved = findVariant(product.variants, groups.value, selectedValues.value);
        if (!resolved) {
          selectedValues.value = Array(groups.value.length).fill(null);
        }
      }
    } catch (error) {
      console.error('[PDP] Live stock refresh failed:', error);
      enhancementError.value = 'Failed to refresh stock';
    } finally {
      isEnhancing.value = false;
    }
  });
  useOnDocument('qidle', $(() => { refreshLiveStock(); }));
  const changeImage = $((newIndex: number) => {
    const newAsset = orderedAssets.value[newIndex];
    if (newAsset) {
      currentImageSig.value = newAsset;
    }
  });
  useTask$(({ track }) => {
    track(() => currentImageSig.value);
    track(() => orderedAssets.value);
    const list = orderedAssets.value;
    if (list.length === 0) return;
    const index = list.findIndex((a) => a.preview === currentImageSig.value.preview);
    if (index === -1) {
      currentImageSig.value = list[0];
      currentImageIndex.value = 0;
    } else {
      currentImageIndex.value = index;
    }
  });
  const galleryRef = useSignal<Element>();
  const scrollToImage = $((index: number) => {
    if (galleryRef.value) {
      const el = galleryRef.value as HTMLElement;
      el.scrollTo({ top: index * el.clientHeight, behavior: 'smooth' });
    }
    currentImageIndex.value = index;
    currentImageSig.value = orderedAssets.value[index];
  });
  const handleGalleryScroll = $((e: Event) => {
    const el = e.target as HTMLElement;
    const idx = Math.round(el.scrollTop / el.clientHeight);
    if (idx !== currentImageIndex.value && idx < orderedAssets.value.length) {
      currentImageIndex.value = idx;
      currentImageSig.value = orderedAssets.value[idx];
    }
  });
  const handleThumbClick$ = $((e: Event) => {
    const idx = Number((e.target as HTMLElement).closest('[data-idx]')?.getAttribute('data-idx'));
    if (!isNaN(idx)) scrollToImage(idx);
  });
  const handleGalleryItemClick$ = $((e: Event) => {
    const el = (e.target as HTMLElement).closest('[data-idx]') as HTMLElement;
    if (!el) return;
    const idx = Number(el.dataset.idx);
    const src = el.dataset.src || '';
    openImageModal(src, idx);
  });
  const handleDotClick$ = $((e: Event) => {
    const idx = Number((e.target as HTMLElement).closest('[data-idx]')?.getAttribute('data-idx'));
    if (!isNaN(idx)) changeImage(idx);
  });
  const { handleTouchStart$, handleTouchMove$, handleTouchEnd$, touchState: _touchState } =
    useImageGalleryTouchHandling(orderedAssets, currentImageIndex, changeImage);
  useTask$(({ track }) => {
    track(() => groups.value.length);
    if (selectedValues.value.length !== groups.value.length)
      selectedValues.value = Array(groups.value.length).fill(null);
  });
  const resolvedVariant = useComputed$(() =>
    findVariant(product.variants, groups.value, selectedValues.value)
  );
  const selectedVariantIdSignal = useSignal<string | undefined>(undefined);
  useTask$(({ track }) => {
    track(() => resolvedVariant.value);
    selectedVariantIdSignal.value = resolvedVariant.value?.sku;
  });
  const availableVariants = useComputed$(() => product.variants);
  const selectedVariant = useComputed$(() =>
    availableVariants.value.find((v) => v.sku === selectedVariantIdSignal.value)
  );
  const isPreOrder = useComputed$(() => {
    if (selectedVariant.value) return !!selectedVariant.value.isPreOrder;
    return product.variants.some((v) => !!v.isPreOrder);
  });
  const hasSale = useComputed$(() => {
    if (selectedVariant.value) {
      return typeof selectedVariant.value.salePrice === 'number' && selectedVariant.value.salePrice > 0;
    }
    return product.variants.some((v) => typeof v.salePrice === 'number' && v.salePrice > 0);
  });
  const allVariantsSoldOut = useComputed$(() =>
    product.variants.every((v) => !v.isPreOrder && !v.inStock)
  );
  const allGroupsSelected = useComputed$(() =>
    groups.value.length > 0 && selectedValues.value.length === groups.value.length && selectedValues.value.every(v => v !== null)
  );
  const isOutOfStock = useComputed$(() => {
    if (!allGroupsSelected.value) return false; // incomplete selection — never OOS
    if (!selectedVariant.value) return false;
    if (isPreOrder.value) return false;
    return !selectedVariant.value.inStock;
  });
  const preOrderConsent = useSignal(false);
  const showCtaTooltip = useSignal(false);
  const ctaTooltipFading = useSignal(false);
  const addItemToOrderErrorSignal = useSignal('');
  const isAddingToCart = useSignal(false);
  const quantitySignal = useSignal<Record<string, number>>({});
  const handleAddToCart = $(async () => {
    if (!isOutOfStock.value) {
      try {
        isAddingToCart.value = true;
        const selectedVar = selectedVariant.value;
        if (!selectedVar) throw new Error('No variant selected');
        const image = (selectedVar.assets?.[0]) ?? orderedAssets.value[0] ?? galleryImages[0];
        const enrichment = toCartEnrichment(product, selectedVar, image);
        await addToCart(cart, selectedVar.sku, 1, enrichment);
        appState.showCart = true;
        loadCountryOnDemand(appState);
        const announcement = document.createElement('div');
        announcement.setAttribute('role', 'status');
        announcement.setAttribute('aria-live', 'polite');
        announcement.className = 'sr-only';
        announcement.textContent = `${product.name} added to cart`;
        document.body.appendChild(announcement);
        setTimeout(() => announcement.remove(), 3000);
      } catch (error) {
        console.error('Error adding item to local cart:', error);
        addItemToOrderErrorSignal.value = 'Failed to add item to cart';
      } finally {
        isAddingToCart.value = false;
      }
    }
  });
  // Per-SKU quantity already in the cart — derived straight from the live
  // cart mirror (CartContext), never from local storage.
  useTask$(({ track }) => {
    track(() => cart.cart.lines);
    const map: Record<string, number> = {};
    for (const line of cart.cart.lines) map[line.sku] = (map[line.sku] ?? 0) + line.quantity;
    quantitySignal.value = map;
  });
  const displayPrice = useComputed$(() => {
    if (selectedVariant.value) return selectedVariant.value.price || 0;
    if (selectedValues.value[0] && groups.value.length > 1) {
      const gName = groups.value[0].groupName;
      const sel = selectedValues.value[0];
      const matching = product.variants.filter((v) =>
        v.options?.find((o) => o.group?.name === gName && o.name === sel)
      );
      if (matching.length) return Math.min(...matching.map((v) => v.price || 0));
    }
    return Math.min(...product.variants.map((v) => v.price || 0));
  });
  const showFromPrefix = useComputed$(() => groups.value.length > 1 && !selectedVariant.value);
  const ctaDisabled = useComputed$(() =>
    !selectedVariant.value || (isPreOrder.value && !preOrderConsent.value)
  );
  const ctaClass = useComputed$(() => {
    if (isOutOfStock.value && selectedVariant.value) return 'sr-cta-btn oos';
    if (ctaDisabled.value) return 'sr-cta-btn disabled';
    if (isPreOrder.value) return 'sr-cta-btn preorder';
    return 'sr-cta-btn ready';
  });
  const _firstUnselected = useComputed$(() =>
    selectedValues.value.findIndex(v => !v)
  );
  return (
    <ProductPageView
      addItemToOrderErrorSignal={addItemToOrderErrorSignal}
      allVariantsSoldOut={allVariantsSoldOut}
      changeImage={changeImage}
      closeImageModal={closeImageModal}
      ctaClass={ctaClass}
      ctaDisabled={ctaDisabled}
      ctaTooltipFading={ctaTooltipFading}
      currentImageIndex={currentImageIndex}
      currentImageSig={currentImageSig}
      displayPrice={displayPrice}
      galleryRef={galleryRef}
      groups={groups}
      handleAddToCart={handleAddToCart}
      handleGroupSelect$={handleGroupSelect$}
      handleDotClick$={handleDotClick$}
      handleGalleryItemClick$={handleGalleryItemClick$}
      handleGalleryScroll={handleGalleryScroll}
      handleThumbClick$={handleThumbClick$}
      handleTouchEnd$={handleTouchEnd$}
      handleTouchMove$={handleTouchMove$}
      handleTouchStart$={handleTouchStart$}
      hasSale={hasSale}
      isAddingToCart={isAddingToCart}
      isImageLoading={isImageLoading}
      isOutOfStock={isOutOfStock}
      isPreOrder={isPreOrder}
      modalImageIndex={modalImageIndex}
      modalImageSrc={modalImageSrc}
      navigateModal={navigateModal}
      openImageModal={openImageModal}
      orderedAssets={orderedAssets}
      preOrderConsent={preOrderConsent}
      product={product}
      quantitySignal={quantitySignal}
      selectedValues={selectedValues}
      selectedVariant={selectedVariant}
      selectedVariantIdSignal={selectedVariantIdSignal}
      showCtaTooltip={showCtaTooltip}
      showFromPrefix={showFromPrefix}
      showImageModal={showImageModal}
    />
  );
});
