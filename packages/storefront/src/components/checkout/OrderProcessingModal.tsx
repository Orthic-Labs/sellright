import { component$, useStylesScoped$ } from '@qwik.dev/core';

interface OrderProcessingModalProps {
  isVisible: boolean;
  currentStage: string;
}

export default component$<OrderProcessingModalProps>(({ isVisible, currentStage }) => {
  // 🚀 OPTIMIZED: CSS-based dots animation (no JavaScript intervals)
  useStylesScoped$(`
    .dots-animation::after {
      content: '';
      animation: dots 1.5s infinite;
      display: inline-block;
      width: 2rem;
      text-align: left;
    }

    @keyframes dots {
      0%, 25% { content: ''; }
      26%, 50% { content: '.'; }
      51%, 75% { content: '..'; }
      76%, 100% { content: '...'; }
    }
  `);

  if (!isVisible) return null;

  return (
    <div class="fixed inset-0 bg-black/75 flex items-center justify-center z-50 backdrop-blur-xs">
      <div class="bg-[#F7F2EA] rounded-2xl shadow-2xl p-8 max-w-md w-full mx-4 text-center relative overflow-hidden">
        {/* Animated background */}
        <div class="absolute inset-0 bg-linear-to-br from-[#f0ebe2] to-[#F7F2EA] opacity-50"></div>
        
        {/* Content */}
        <div class="relative z-10">
          {/* Spinner */}
          <div class="mb-6">
            <div class="mx-auto w-16 h-16 border-4 border-gray-200 border-t-black rounded-full animate-spin"></div>
          </div>
          
          {/* Main message */}
          <h2 class="text-2xl font-bold text-gray-900 mb-2">
            Processing Your Order
          </h2>
          
          {/* Stage message */}
          <p class="text-lg text-gray-600 mb-6 min-h-7">
            {currentStage}<span class="dots-animation inline-block w-8 text-left"></span>
          </p>
          
          {/* Fun sub-message */}
          <div class="bg-gray-50 rounded-lg p-4 border-l-4 border-black">
            <p class="text-sm text-gray-600 italic">
              "Good things come to those who wait... and we're crafting something damn good for you!"
            </p>
          </div>
          
          {/* Progress indicator */}
          <div class="mt-6">
            <div class="bg-gray-200 rounded-full h-2 overflow-hidden">
              <div class="bg-linear-to-r from-gray-800 to-black h-full rounded-full animate-pulse"></div>
            </div>
          </div>
        </div>
        
        {/* Decorative elements */}
        <div class="absolute top-4 right-4 text-gray-300">
          <svg class="w-6 h-6 animate-bounce" fill="currentColor" viewBox="0 0 20 20">
            <path fill-rule="evenodd" d="M3.172 5.172a4 4 0 015.656 0L10 6.343l1.172-1.171a4 4 0 115.656 5.656L10 17.657l-6.828-6.829a4 4 0 010-5.656z" clip-rule="evenodd" />
          </svg>
        </div>
        
        <div class="absolute bottom-4 left-4 text-gray-300">
          <svg class="w-6 h-6 animate-pulse" fill="currentColor" viewBox="0 0 20 20">
            <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
          </svg>
        </div>
      </div>
    </div>
  );
});
