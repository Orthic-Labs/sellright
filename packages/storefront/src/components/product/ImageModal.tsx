import { component$, type QRL } from '@qwik.dev/core';
import { OptimizedImage } from '~/components/ui';

interface ImageModalProps {
  src: string;
  index: number;
  assets: any[];
  onClose$: QRL<() => void>;
  onNavigate$: QRL<(direction: 'prev' | 'next') => void>;
  isLoading?: boolean;
}

export default component$<ImageModalProps>(({
  src,
  index,
  assets,
  onClose$,
  onNavigate$,
  isLoading = false
}) => {
  return (
    <div
      class="fixed inset-0 z-50 bg-black animate-fade-in"
      onClick$={(e) => {
        if (e.target === e.currentTarget) {
          onClose$();
        }
      }}
    >
      {/* Close button — top right, safe-area aware */}
      <button
        class="absolute top-4 right-4 z-20 min-w-[44px] min-h-[44px] flex items-center justify-center text-white/70 hover:text-white transition-colors duration-200"
        style={{ top: 'max(16px, env(safe-area-inset-top, 16px))' }}
        onClick$={(e) => {
          e.stopPropagation();
          onClose$();
        }}
        aria-label="Close"
      >
        <svg class="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>

      {/* Image counter — top center */}
      {assets.length > 1 && (
        <div
          class="absolute top-4 left-1/2 -translate-x-1/2 z-20 text-white/50 text-xs tracking-[2px] uppercase font-heading"
          style={{ top: 'max(16px, env(safe-area-inset-top, 16px))' }}
          onClick$={(e) => e.stopPropagation()}
        >
          {index + 1} / {assets.length}
        </div>
      )}

      {/* Full-screen image area */}
      <div class="w-full h-full flex items-center justify-center" onClick$={(e) => e.stopPropagation()}>
        {/* Loading spinner */}
        {isLoading && (
          <div class="absolute inset-0 flex items-center justify-center z-10">
            <div class="animate-spin rounded-full h-10 w-10 border-2 border-white/20 border-t-white/80"></div>
          </div>
        )}

        <OptimizedImage
          src={src}
          class="max-w-full max-h-full w-auto h-auto object-contain transition-opacity duration-300"
          alt={`Product detail view ${index + 1} of ${assets.length}`}
          loading="eager"
        />
      </div>

      {/* Previous button */}
      {assets.length > 1 && index > 0 && (
        <button
          class="absolute left-2 top-1/2 -translate-y-1/2 z-20 min-w-[44px] min-h-[44px] flex items-center justify-center text-white/50 hover:text-white transition-colors duration-200"
          onClick$={(e) => {
            e.stopPropagation();
            onNavigate$('prev');
          }}
          aria-label="Previous image"
        >
          <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
      )}

      {/* Next button */}
      {assets.length > 1 && index < assets.length - 1 && (
        <button
          class="absolute right-2 top-1/2 -translate-y-1/2 z-20 min-w-[44px] min-h-[44px] flex items-center justify-center text-white/50 hover:text-white transition-colors duration-200"
          onClick$={(e) => {
            e.stopPropagation();
            onNavigate$('next');
          }}
          aria-label="Next image"
        >
          <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </button>
      )}
    </div>
  );
});
