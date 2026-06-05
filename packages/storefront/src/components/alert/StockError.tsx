import { component$, type QRL } from '@qwik.dev/core';
import XCircleIcon from '../icons/XCircleIcon';

export interface StockErrorProps {
  productName: string;
  requestedQuantity: number;
  availableStock: number;
  onRemoveItem?: QRL<() => void>;
  onAdjustQuantity?: QRL<() => void>;
}

export default component$<StockErrorProps>(({ 
  productName, 
  requestedQuantity, 
  availableStock, 
  onRemoveItem,
  onAdjustQuantity 
}) => {
  const isOutOfStock = availableStock === 0;
  
  return (
    <div class="rounded-md bg-red-50 p-4 border border-red-200">
      <div class="flex">
        <div class="shrink-0">
          <XCircleIcon />
        </div>
        <div class="ml-3 flex-1">
          <h3 class="text-sm font-medium text-red-800">
            {isOutOfStock ? 'Item Out of Stock' : 'Insufficient Stock'}
          </h3>
          <div class="mt-2 text-sm text-red-700">
            <p>
              {isOutOfStock 
                ? `"${productName}" is currently out of stock.`
                : `Only ${availableStock} available for "${productName}" (you requested ${requestedQuantity}).`
              }
            </p>
          </div>
          
          <div class="mt-4 flex space-x-3">
            {onRemoveItem && (
              <button
                type="button"
                class="bg-red-100 px-3 py-2 rounded-md text-sm font-medium text-red-800 hover:bg-red-200 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
                onClick$={onRemoveItem}
              >
                Remove from Cart
              </button>
            )}
            
            {!isOutOfStock && onAdjustQuantity && (
              <button
                type="button"
                class="bg-white px-3 py-2 rounded-md text-sm font-medium text-red-800 border border-red-300 hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
                onClick$={onAdjustQuantity}
              >
                Adjust to {availableStock}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});