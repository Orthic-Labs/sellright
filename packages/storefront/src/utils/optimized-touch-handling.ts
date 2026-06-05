/**
 * RAF-Optimized Touch Handling Utility
 * Eliminates mobile jank by using requestAnimationFrame for smooth touch interactions
 */

import { Signal, useSignal, $, QRL } from '@qwik.dev/core';

export interface TouchState {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  deltaX: number;
  deltaY: number;
  isActive: boolean;
  isSwiping: boolean;
  didSwipe: boolean;
}

export interface OptimizedTouchHandlers {
  handleTouchStart$: QRL<(event: TouchEvent) => void>;
  handleTouchMove$: QRL<(event: TouchEvent) => void>;
  handleTouchEnd$: QRL<(event: TouchEvent) => void>;
  touchState: Signal<TouchState>;
  rafId: Signal<number | null>;
}

/**
 * Creates optimized touch handlers using RAF for smooth performance
 */
export const useOptimizedTouchHandling = (
  onSwipeLeft$?: QRL<() => void>,
  onSwipeRight$?: QRL<() => void>,
  swipeThreshold: number = 50,
  _preventScrollThreshold: number = 30
): OptimizedTouchHandlers => {
  
  const touchState = useSignal<TouchState>({
    startX: 0,
    startY: 0,
    currentX: 0,
    currentY: 0,
    deltaX: 0,
    deltaY: 0,
    isActive: false,
    isSwiping: false,
    didSwipe: false
  });

  const rafId = useSignal<number | null>(null);

  const handleTouchStart$ = $((event: TouchEvent) => {
    const touch = event.touches[0];

    touchState.value = {
      startX: touch.clientX,
      startY: touch.clientY,
      currentX: touch.clientX,
      currentY: touch.clientY,
      deltaX: 0,
      deltaY: 0,
      isActive: true,
      isSwiping: false,
      didSwipe: false
    };
  });

  const handleTouchMove$ = $((event: TouchEvent) => {
    if (!touchState.value.isActive) return;

    // Cancel previous RAF if still pending
    if (rafId.value) {
      cancelAnimationFrame(rafId.value);
    }

    // Use RAF for smooth gesture handling
    rafId.value = requestAnimationFrame(() => {
      const touch = event.touches[0];
      const deltaX = touch.clientX - touchState.value.startX;
      const deltaY = touch.clientY - touchState.value.startY;
      const absDeltaX = Math.abs(deltaX);
      const absDeltaY = Math.abs(deltaY);

      // Update touch state
      touchState.value = {
        ...touchState.value,
        currentX: touch.clientX,
        currentY: touch.clientY,
        deltaX,
        deltaY,
        isSwiping: absDeltaX > absDeltaY && absDeltaX > 10
      };

      // Note: preventDefault removed - use passive: false in addEventListener options if needed
    });
  });

  const handleTouchEnd$ = $((_event: TouchEvent) => {
    if (!touchState.value.isActive) return;

    // Cancel any pending RAF
    if (rafId.value) {
      cancelAnimationFrame(rafId.value);
      rafId.value = null;
    }

    const { deltaX, deltaY, isSwiping } = touchState.value;
    const absDeltaX = Math.abs(deltaX);
    const absDeltaY = Math.abs(deltaY);

    // Determine if this was a valid swipe
    const isValidSwipe = isSwiping &&
                        absDeltaX > swipeThreshold &&
                        absDeltaX > absDeltaY;

    if (isValidSwipe) {
      touchState.value = { ...touchState.value, didSwipe: true };

      // Execute swipe callbacks
      if (deltaX > 0 && onSwipeRight$) {
        onSwipeRight$();
      } else if (deltaX < 0 && onSwipeLeft$) {
        onSwipeLeft$();
      }
    }

    // Reset touch state
    touchState.value = {
      ...touchState.value,
      isActive: false,
      isSwiping: false
    };
  });

  return {
    handleTouchStart$,
    handleTouchMove$,
    handleTouchEnd$,
    touchState,
    rafId
  };
};

/**
 * Cleanup function for touch handlers
 */
export const cleanupTouchHandling = (rafId: Signal<number | null>) => {
  if (rafId.value) {
    cancelAnimationFrame(rafId.value);
    rafId.value = null;
  }
};

/**
 * Optimized touch handling for image galleries/carousels
 */
export const useImageGalleryTouchHandling = (
  assets: Signal<any[]>,
  currentIndex: Signal<number>,
  onImageChange$: QRL<(newIndex: number) => void>
) => {

  const goToPrevious$ = $(() => {
    if (assets.value.length <= 1) return;
    const newIndex = currentIndex.value > 0
      ? currentIndex.value - 1
      : assets.value.length - 1;
    onImageChange$(newIndex);
  });

  const goToNext$ = $(() => {
    if (assets.value.length <= 1) return;
    const newIndex = currentIndex.value < assets.value.length - 1
      ? currentIndex.value + 1
      : 0;
    onImageChange$(newIndex);
  });

  return useOptimizedTouchHandling(
    goToNext$,    // Swipe left = next image
    goToPrevious$, // Swipe right = previous image
    50,          // 50px swipe threshold
    30           // 30px prevent scroll threshold
  );
};
