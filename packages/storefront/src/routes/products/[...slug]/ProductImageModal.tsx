import { component$ } from '@qwik.dev/core';
import { OptimizedImage } from '~/components/ui';

export const ProductImageModal = component$((props: Record<string, any>) => {
  const {
    closeImageModal,
    isImageLoading,
    modalImageIndex,
    modalImageSrc,
    navigateModal,
    orderedAssets,
    product,
  } = props;
  return (
    <div class="dd-modal"
      onClick$={e => { if (e.target === e.currentTarget) closeImageModal(); }}
    >
      <button class="dd-modal-close" onClick$={closeImageModal} aria-label="Close">x</button>
      <div class="dd-modal-inner">
        {isImageLoading.value && <div class="dd-img-loading"><div class="dd-spinner" /></div>}
        <OptimizedImage
          src={modalImageSrc.value}
          alt={`${product.name} enlarged view ${modalImageIndex.value + 1} of ${orderedAssets.value.length} - Premium knife detail from Damned Designs`}
          loading="eager"
          responsive="productMain"
          onClick$={e => e.stopPropagation()}
        />
      </div>
      {orderedAssets.value.length > 1 && (
        <>
          {modalImageIndex.value > 0 && (
            <button class="dd-modal-nav dd-modal-prev"
              onClick$={e => { e.stopPropagation(); navigateModal('prev'); }}
              aria-label="Previous image">
              <svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7"/>
              </svg>
            </button>
          )}
          {modalImageIndex.value < orderedAssets.value.length - 1 && (
            <button class="dd-modal-nav dd-modal-next"
              onClick$={e => { e.stopPropagation(); navigateModal('next'); }}
              aria-label="Next image">
              <svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/>
              </svg>
            </button>
          )}
          <div class="dd-modal-counter">
            {modalImageIndex.value + 1} / {orderedAssets.value.length}
          </div>
        </>
      )}
    </div>
  );
});
