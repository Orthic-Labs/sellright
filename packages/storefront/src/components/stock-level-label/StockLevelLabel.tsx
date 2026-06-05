import { component$ } from '@qwik.dev/core';

// Legacy type kept for backwards compatibility
export type StockLevel = 'IN_STOCK' | 'OUT_OF_STOCK' | 'LOW_STOCK';

export default component$<{ stockLevel?: string }>(({ stockLevel }) => {
	let stockLevelLabel = '';
	let badgeClasses = 'bg-gray-100 text-gray-800';
	
	// Handle numeric stock levels (as strings)
	if (stockLevel !== undefined && stockLevel !== null) {
		const numericStock = parseInt(stockLevel, 10);
		
		// Check if it's a valid number
		if (!isNaN(numericStock)) {
			if (numericStock <= 0) {
				// Out of stock
				stockLevelLabel = `No stock`;
				badgeClasses = 'bg-red-100 text-red-800';
			} else if (numericStock < 5) {
				// Low stock (less than 5)
				stockLevelLabel = `Low stock`;
				badgeClasses = 'bg-yellow-100 text-yellow-800';
			} else {
				// In stock
				stockLevelLabel = `In stock`;
				badgeClasses = 'bg-green-100 text-green-800';
			}
			return (
				<span class={'inline-flex items-center px-2 py-0.5 rounded-sm text-xs font-medium ' + badgeClasses}>
					{stockLevelLabel}
				</span>
			);
		}
	}
	
	// Fallback for legacy enum values
	switch (stockLevel) {
		case 'IN_STOCK':
			stockLevelLabel = `In stock`;
			badgeClasses = 'bg-green-100 text-green-800';
			break;
		case 'OUT_OF_STOCK':
			stockLevelLabel = `No stock`;
			badgeClasses = 'bg-red-100 text-red-800';
			break;
		case 'LOW_STOCK':
			stockLevelLabel = `Low stock`;
			badgeClasses = 'bg-yellow-100 text-yellow-800';
			break;
	}
	return (
		<span
			class={'inline-flex items-center px-2 py-0.5 rounded-sm text-xs font-medium ' + badgeClasses}
		>
			{stockLevelLabel}
		</span>
	);
});
