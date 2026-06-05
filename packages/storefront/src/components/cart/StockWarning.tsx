import { component$, type QRL } from '@qwik.dev/core';
import type { LocalCartItem } from '~/services/LocalCartService';

interface StockWarningProps {
  item: LocalCartItem;
  variantId: string;
  onRemove$: QRL<(variantId: string) => void>;
}

export const StockWarning = component$<StockWarningProps>(({ item, variantId, onRemove$ }) => {
  const stockLevel = parseInt(item.productVariant.stockLevel || '0');
  
  if (stockLevel <= 0) {
    return (
      <div class="bg-red-50 border-l-4 border-red-400 p-3 mb-2">
        <div class="flex items-center justify-between">
          <div class="flex items-center">
            <svg class="w-4 h-4 text-red-500 mr-2" fill="currentColor" viewBox="0 0 20 20">
              <path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd" />
            </svg>
            <span class="text-red-700 text-sm font-medium">Out of stock</span>
          </div>
          <button
            onClick$={() => onRemove$(variantId)}
            class="text-red-600 hover:text-red-800 text-sm font-medium underline"
          >
            Remove
          </button>
        </div>
      </div>
    );
  }
  
  if (stockLevel <= 5) {
    return (
      <div class="mb-1">
        <span style="font-size:11px;letter-spacing:0.5px;color:rgba(150,83,65,0.7)">Only {stockLevel} left</span>
      </div>
    );
  }
  
  return null;
});