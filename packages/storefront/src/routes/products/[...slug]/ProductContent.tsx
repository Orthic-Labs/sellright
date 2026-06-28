import { $, component$, useComputed$, useContext, useOnDocument, useOnWindow, useSignal, useStore, useTask$ } from '@qwik.dev/core';
import { APP_STATE } from '~/constants';
import { getProductStockLevelsOnly } from '~/providers/shop/products/products';
import type { Variant } from '~/types';
import { LocalCartService, type LocalCartItem } from '~/services/LocalCartService';
import { useLocalCart, addToLocalCart } from '~/contexts/CartContext';
import { loadCountryOnDemand } from '~/utils/addressStorage';
import { useImageGalleryTouchHandling } from '~/utils/optimized-touch-handling';
import { ProductPageView } from './ProductPageView';
import { findVariant, getOptionGroups } from './product-options';
export const ProductContent = component$(({ loaderResult }: { loaderResult: any }) => {
  const appState = useContext(APP_STATE);
  const localCart = useLocalCart();
  if (!loaderResult || (loaderResult as any).message || !(loaderResult as any).product) {
    return (
      <div class="min-h-[50vh] flex flex-col items-center justify-center py-16 px-4">
        <h1 class="text-2xl font-bold text-gray-900 mb-3">Product Not Found</h1>
        <p class="text-gray-500 mb-6">This product may have been discontinued or is no longer available.</p>
        <a href="/shop" class="inline-flex items-center px-6 py-2.5 bg-black text-white text-sm font-medium uppercase tracking-wider hover:bg-gray-800 transition-colors">Browse Products</a>
      </div>
    );
  }
  const product = useStore(loaderResult.product || loaderResult);
  if (!product || !product.assets || !product.variants || product.variants.length === 0) {
    return <div class="text-center py-8">Product not found</div>;
  }
  const isEnhancing = useSignal(false);
  const enhancementError = useSignal<string | null>(null);
  const currentImageSig = useSignal(
    product.featuredAsset ||
      (product.assets.length > 0 ? product.assets[0] : { id: '', preview: '/asset_placeholder.webp', name: 'Placeholder' }),
  );
  const currentImageIndex = useSignal(0);
  const groups = useComputed$(() => getOptionGroups(product.variants));
  const selectedValues = useSignal<(string | null)[]>([]);
  const hasVariantAssets = Boolean((product as any).hasVariantAssets) ||
    (product.variants || []).some((v: any) => (v.assets?.length || 0) > 0);
  const baseGalleryList: any[] = (() => {
    if (!product.featuredAsset || !product.assets) return product.assets || [];
    const idx = product.assets.findIndex(
      (a: any) => a.id === product.featuredAsset?.id || a.preview === product.featuredAsset?.preview,
    );
    if (idx === -1) return [product.featuredAsset, ...product.assets];
    if (idx === 0) return product.assets;
    const arr = [...product.assets];
    const [f] = arr.splice(idx, 1);
    return [f, ...arr];
  })();
  const orderedAssets = useSignal<any[]>(baseGalleryList);
  const showImageModal = useSignal(false);
  const modalImageSrc = useSignal('');
  const isImageLoading = useSignal(false);
  const modalImageIndex = useSignal(0);
  const openImageModal = $((imageSrc: string, imageIndex?: number) => {
    modalImageSrc.value = imageSrc;
    modalImageIndex.value = imageIndex ?? orderedAssets.value.findIndex(
      (a: any) => a.preview === imageSrc.replace(/\?preset=modal$/, ''),
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
      let list: any[] = baseGalleryList;
      if (firstGroupName && firstSel) {
        const seen = new Set<string>();
        const union: any[] = [];
        for (const v of product.variants as Variant[]) {
          const match = v.options?.some(
            (o: any) => o.group?.name === firstGroupName && o.name === firstSel,
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
      const result: any = await getProductStockLevelsOnly(product.slug);
      const liveVariants: Array<{ id: string; stockLevel: string }> = result?.product?.variants || [];
      if (!liveVariants.length) return;
      const stockById = new Map(liveVariants.map(v => [String(v.id), v.stockLevel]));
      product.variants = (product.variants || []).map((v: any) => ({
        ...v,
        stockLevel: stockById.get(String(v.id)) ?? '0',
      }));
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
    const index = list.findIndex(
      (a: any) => a.id === currentImageSig.value.id || a.preview === currentImageSig.value.preview,
    );
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
    selectedVariantIdSignal.value = resolvedVariant.value?.id;
  });
  const availableVariants = useComputed$(() => product.variants);
  const selectedVariant = useComputed$(() =>
    availableVariants.value.find((v: Variant) => v.id === selectedVariantIdSignal.value)
  );
  const isPreOrder = useComputed$(() => {
    if (selectedVariant.value) {
      return !!(selectedVariant.value as any)?.customFields?.isPreOrder;
    }
    return product.variants.some((v: any) => !!v.customFields?.isPreOrder);
  });
  const hasSale = useComputed$(() => {
    if (selectedVariant.value) {
      const p = selectedVariant.value?.customFields?.salePrice;
      return typeof p === 'number' && p > 0;
    }
    return product.variants.some((v: any) => typeof v.customFields?.salePrice === 'number' && v.customFields.salePrice > 0);
  });
  const allVariantsSoldOut = useComputed$(() =>
    product.variants.every((v: Variant) => {
      const stock = parseInt((v as any).stockLevel || '0', 10);
      const cf = (v as any).customFields;
      return !cf?.isPreOrder && stock <= 0;
    })
  );
  const allGroupsSelected = useComputed$(() =>
    groups.value.length > 0 && selectedValues.value.length === groups.value.length && selectedValues.value.every(v => v !== null)
  );
  const isOutOfStock = useComputed$(() => {
    if (!allGroupsSelected.value) return false; // incomplete selection — never OOS
    if (!selectedVariant.value) return false;
    if (isPreOrder.value) return false;
    return parseInt(selectedVariant.value?.stockLevel || '0', 10) <= 0;
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
        const rawSalePrice = selectedVar.customFields?.salePrice;
        const rawPreOrderPrice = selectedVar.customFields?.preOrderPrice;
        const effectiveSalePrice = typeof rawSalePrice === 'number' && rawSalePrice > 0 ? rawSalePrice : undefined;
        const effectivePreOrderPrice = typeof rawPreOrderPrice === 'number' && rawPreOrderPrice > 0 ? rawPreOrderPrice : undefined;
        const localCartItem: LocalCartItem = {
          productVariantId: selectedVar.id,
          quantity: 1,
          isPreOrder: isPreOrder.value,
          shipDate: selectedVar.customFields?.shipDate,
          salePrice: effectiveSalePrice,
          preOrderPrice: effectivePreOrderPrice,
          productVariant: {
            id: selectedVar.id,
            name: selectedVar.name,
            price: selectedVar.priceWithTax || selectedVar.price || 0,
            stockLevel: selectedVar.stockLevel,
            product: { id: product.id, name: product.name, slug: product.slug },
            options: selectedVar.options || [],
            featuredAsset: selectedVar.featuredAsset || product.featuredAsset,
          },
        };
        await addToLocalCart(localCart, localCartItem);
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
  useOnDocument('qinit', $(() => {
    const variantIds = (product.variants || []).map((v: Variant) => v.id);
    quantitySignal.value = LocalCartService.getItemQuantitiesFromStorage(variantIds);
  }));
  useOnWindow('cart-updated', $(() => {
    const variantIds = (product.variants || []).map((v: Variant) => v.id);
    quantitySignal.value = LocalCartService.getItemQuantitiesFromStorage(variantIds);
  }));
  const displayPrice = useComputed$(() => {
    if (selectedVariant.value) return selectedVariant.value.priceWithTax || selectedVariant.value.price || 0;
    if (selectedValues.value[0] && groups.value.length > 1) {
      const gName = groups.value[0].groupName;
      const sel = selectedValues.value[0];
      const matching = product.variants.filter((v: Variant) =>
        v.options?.find((o: any) => o.group?.name === gName && o.name === sel)
      );
      if (matching.length) return Math.min(...matching.map((v: Variant) => v.priceWithTax || v.price || 0));
    }
    return Math.min(...product.variants.map((v: Variant) => v.priceWithTax || v.price || 0));
  });
  const showFromPrefix = useComputed$(() => groups.value.length > 1 && !selectedVariant.value);
  const ctaDisabled = useComputed$(() =>
    !selectedVariant.value || (isPreOrder.value && !preOrderConsent.value)
  );
  const ctaClass = useComputed$(() => {
    if (isOutOfStock.value && selectedVariant.value) return 'dd-cta-btn oos';
    if (ctaDisabled.value) return 'dd-cta-btn disabled';
    if (isPreOrder.value) return 'dd-cta-btn preorder';
    return 'dd-cta-btn ready';
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
      displayPrice={displayPrice}
      galleryRef={galleryRef}
      groups={groups}
      handleAddToCart={handleAddToCart}
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