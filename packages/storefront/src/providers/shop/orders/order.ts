import {
	CreateAddressInput,
	CreateCustomerInput,
	Order,
} from '~/generated/graphql-shop';
import {
	ActiveOrderDocument, type ActiveOrderQuery as ActiveOrderQueryT, type ActiveOrderQueryVariables,
	OrderByCodeDocument, type OrderByCodeQuery as OrderByCodeQueryT, type OrderByCodeQueryVariables,
	AddItemToOrderDocument, type AddItemToOrderMutation as AddItemToOrderMutationT, type AddItemToOrderMutationVariables,
	RemoveOrderLineDocument, type RemoveOrderLineMutation as RemoveOrderLineMutationT, type RemoveOrderLineMutationVariables,
	RemoveAllOrderLinesDocument, type RemoveAllOrderLinesMutation as RemoveAllOrderLinesMutationT, type RemoveAllOrderLinesMutationVariables,
	AdjustOrderLineDocument, type AdjustOrderLineMutation as AdjustOrderLineMutationT, type AdjustOrderLineMutationVariables,
	SetOrderShippingAddressDocument, type SetOrderShippingAddressMutation as SetOrderShippingAddressMutationT, type SetOrderShippingAddressMutationVariables,
	SetOrderShippingMethodDocument, type SetOrderShippingMethodMutation as SetOrderShippingMethodMutationT, type SetOrderShippingMethodMutationVariables,
	SetCustomerForOrderDocument, type SetCustomerForOrderMutation as SetCustomerForOrderMutationT, type SetCustomerForOrderMutationVariables,
	ApplyCouponCodeDocument, type ApplyCouponCodeMutation as ApplyCouponCodeMutationT, type ApplyCouponCodeMutationVariables,
	RemoveCouponCodeDocument, type RemoveCouponCodeMutation as RemoveCouponCodeMutationT, type RemoveCouponCodeMutationVariables,
	ValidateLocalCartCouponDocument, type ValidateLocalCartCouponQuery as ValidateLocalCartCouponQueryT, type ValidateLocalCartCouponQueryVariables,
	SetOrderBillingAddressDocument, type SetOrderBillingAddressMutation as SetOrderBillingAddressMutationT, type SetOrderBillingAddressMutationVariables,
	VerifySezzlePaymentDocument, type VerifySezzlePaymentMutation as VerifySezzlePaymentMutationT, type VerifySezzlePaymentMutationVariables,
} from '~/generated/graphql-shop-typed';
import { requester } from '~/utils/api';

export const getActiveOrderQuery = async () => {
	const res = await requester<ActiveOrderQueryT, ActiveOrderQueryVariables>(ActiveOrderDocument, undefined);
	return res.activeOrder as Order;
};

export const getOrderByCodeQuery = async (code: string) => {
	const res = await requester<OrderByCodeQueryT, OrderByCodeQueryVariables>(OrderByCodeDocument, { code });
	return res.orderByCode as Order;
};

export const addItemToOrderMutation = async (productVariantId: string, quantity: number) => {
	const res = await requester<AddItemToOrderMutationT, AddItemToOrderMutationVariables>(
		AddItemToOrderDocument,
		{ productVariantId, quantity }
	);
	return res.addItemToOrder;
};

export const addItemsToOrderMutation = async (_items: Array<{ productVariantId: string; quantity: number }>) => {
	// Returns null to trigger LocalCartService's per-item addItemToOrder fallback.
	// Vendure 3.6 changed addItemsToOrder's result type (Order union → struct), making
	// the previous batched query obsolete; the fallback path already handles the use case.
	return null;
};

export const removeOrderLineMutation = async (lineId: string) => {
	const res = await requester<RemoveOrderLineMutationT, RemoveOrderLineMutationVariables>(
		RemoveOrderLineDocument,
		{ orderLineId: lineId }
	);
	const result = res.removeOrderLine;
	// Handle ErrorResult case (e.g., when removing last item)
	if (result && 'errorCode' in result) {
		// If it's an error (like ORDER_MODIFICATION_ERROR when order becomes empty),
		// return null to indicate the order is now empty/invalid
		return null;
	}
	return result as Order;
};

export const removeAllOrderLinesMutation = async () => {
	try {
		const result = await requester<RemoveAllOrderLinesMutationT, RemoveAllOrderLinesMutationVariables>(
			RemoveAllOrderLinesDocument,
			undefined
		);
		const data = result.removeAllOrderLines;
		if (data && 'errorCode' in data) {
			console.log('Remove all order lines resulted in error:', data.errorCode);
			return null;
		}
		return data as Order;
	} catch (error: any) {
		console.error('Error in removeAllOrderLinesMutation:', error);
		throw error;
	}
};

export const adjustOrderLineMutation = async (lineId: string, quantity: number) => {
	const res = await requester<AdjustOrderLineMutationT, AdjustOrderLineMutationVariables>(
		AdjustOrderLineDocument,
		{ orderLineId: lineId, quantity }
	);
	return res.adjustOrderLine as Order;
};

export const setOrderShippingAddressMutation = async (input: CreateAddressInput) => {
	const res = await requester<SetOrderShippingAddressMutationT, SetOrderShippingAddressMutationVariables>(
		SetOrderShippingAddressDocument,
		{ input }
	);
	return res.setOrderShippingAddress;
};

export const setOrderShippingMethodMutation = async (shippingMethodId: string[]) => {
	const res = await requester<SetOrderShippingMethodMutationT, SetOrderShippingMethodMutationVariables>(
		SetOrderShippingMethodDocument,
		{ shippingMethodId }
	);
	return res.setOrderShippingMethod as Order;
};

export const setCustomerForOrderMutation = async (input: CreateCustomerInput) => {
	const res = await requester<SetCustomerForOrderMutationT, SetCustomerForOrderMutationVariables>(
		SetCustomerForOrderDocument,
		{ input }
	);
	return res.setCustomerForOrder;
};

export const applyCouponCodeMutation = async (couponCode: string) => {
	const res = await requester<ApplyCouponCodeMutationT, ApplyCouponCodeMutationVariables>(
		ApplyCouponCodeDocument,
		{ couponCode }
	);
	return res.applyCouponCode;
};

export const removeCouponCodeMutation = async (couponCode: string) => {
	const res = await requester<RemoveCouponCodeMutationT, RemoveCouponCodeMutationVariables>(
		RemoveCouponCodeDocument,
		{ couponCode }
	);
	return res.removeCouponCode;
};

// Custom coupon validation for local cart (bypasses SDK since schema isn't introspected)
export const validateLocalCartCouponQuery = async (input: {
	couponCode: string;
	cartTotal: number;
	cartItems: Array<{
		productVariantId: string;
		quantity: number;
		unitPrice: number;
	}>;
	customerId?: string;
}): Promise<{
	isValid: boolean;
	validationErrors: string[];
	appliedCouponCode?: string;
	discountAmount: number;
	discountPercentage?: number;
	freeShipping: boolean;
	promotionName?: string;
	promotionDescription?: string;
}> => {
	const result = await requester<ValidateLocalCartCouponQueryT, ValidateLocalCartCouponQueryVariables>(
		ValidateLocalCartCouponDocument,
		{ input: input as any }
	);
	return result.validateLocalCartCoupon as any;
};

export const setOrderBillingAddressMutation = async (input: CreateAddressInput) => {
	const res = await requester<SetOrderBillingAddressMutationT, SetOrderBillingAddressMutationVariables>(
		SetOrderBillingAddressDocument,
		{ input }
	);
	return res.setOrderBillingAddress;
};

export const verifySezzlePaymentMutation = async (orderCode: string): Promise<{ success: boolean; message: string }> => {
	const result = await requester<VerifySezzlePaymentMutationT, VerifySezzlePaymentMutationVariables>(
		VerifySezzlePaymentDocument,
		{ orderCode }
	);
	return result.verifySezzlePayment;
};
