import { component$, useComputed$ } from '@qwik.dev/core';
import { formatPrice } from '~/utils';

type Props = {
	countryCode?: string;
	orderTotalAfterDiscount: number;
	currencyCode?: string;
};

const FREE_SHIPPING_THRESHOLD_US = 10000; // $100.00 in cents for US/PR
const FREE_SHIPPING_THRESHOLD_INTL = 20000; // $200.00 in cents for international
const US_PR_COUNTRIES = ['US', 'PR'];

export default component$<Props>(({ countryCode, orderTotalAfterDiscount, currencyCode }) => {
	const isUSPR = useComputed$(() => {
		return countryCode ? US_PR_COUNTRIES.includes(countryCode) : false;
	});

	const threshold = useComputed$(() => {
		return isUSPR.value ? FREE_SHIPPING_THRESHOLD_US : FREE_SHIPPING_THRESHOLD_INTL;
	});

	const remainingAmount = useComputed$(() => {
		return Math.max(0, threshold.value - orderTotalAfterDiscount);
	});

	const progressPercentage = useComputed$(() => {
		return Math.min(100, (orderTotalAfterDiscount / threshold.value) * 100);
	});

	const hasQualified = useComputed$(() => {
		return orderTotalAfterDiscount >= threshold.value;
	});

	// Only show when country is selected and free shipping hasn't been achieved
	if (!countryCode || hasQualified.value) {
		return null;
	}

	return (
		<div class="bg-[#F7F2EA] border border-[#E5E0D8] rounded-md p-3 mb-4">
			<div class="flex items-center justify-between mb-2">
				<span class="text-sm text-[#1A1A1A]">
					Free Shipping
				</span>
				<span class="text-xs text-[#9A9288]">
					{formatPrice(remainingAmount.value, currencyCode)} away
				</span>
			</div>

			{/* Progress Bar */}
			<div class="w-full bg-[#E5E0D8] rounded-full h-1.5">
				<div
					class="bg-[#965341] h-1.5 rounded-full transition-all duration-300 ease-out"
					style={`width: ${progressPercentage.value}%`}
				></div>
			</div>
		</div>
	);
});
