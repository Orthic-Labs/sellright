import { setOrderShippingAddressMutation, setOrderBillingAddressMutation, setOrderShippingMethodMutation } from '~/providers/shop/orders/order';
import type { Order } from '~/generated/graphql-shop';

export interface AddressInput {
  fullName: string;
  streetLine1: string;
  streetLine2?: string;
  city: string;
  province: string;
  postalCode: string;
  countryCode: string;
  phoneNumber?: string;
  company?: string;
}

export interface BillingAddressInput {
  fullName: string;
  streetLine1: string;
  streetLine2?: string;
  city: string;
  province: string;
  postalCode: string;
  countryCode: string;
}

export interface ParallelCheckoutResult {
  order: Order;
  shippingMethodsApplied: boolean;
  errors: string[];
}

export class CheckoutOptimizationService {


  /**
   * Processes address setting and shipping method selection in parallel
   * This reduces checkout time by running independent operations concurrently
   */
  static async processAddressAndShippingParallel(
    shippingAddress: AddressInput,
    billingAddress?: BillingAddressInput,
    orderSubTotal: number = 0
  ): Promise<ParallelCheckoutResult> {
    const errors: string[] = [];
    let finalOrder: Order | null = null;
    let shippingMethodsApplied = false;

    try {
      // Start all parallel operations
      const operations = [];

      // 1. Set shipping address (always required)
      const shippingAddressPromise = setOrderShippingAddressMutation(shippingAddress);
      operations.push(shippingAddressPromise);

      // 2. Set billing address if different (optional)
      let billingAddressPromise: Promise<any> | null = null;
      if (billingAddress) {
        billingAddressPromise = setOrderBillingAddressMutation(billingAddress);
        operations.push(billingAddressPromise);
      }

      // 3. Determine shipping method using efficient hardcoded logic (no GraphQL queries needed)
      // Since we only have 3 fixed shipping methods, use hardcoded IDs for efficiency
      const shippingMethodId = (shippingAddress.countryCode === 'US' || shippingAddress.countryCode === 'PR')
        ? (orderSubTotal >= 10000 ? '6' : '3')
        : '7';

      // Execute address operations in parallel
      const results = await Promise.allSettled(operations);

      // Process shipping address result
      const shippingResult = results[0];
      if (shippingResult.status === 'fulfilled') {
        const shippingOrder = shippingResult.value;
        if (shippingOrder.__typename === 'Order') {
          finalOrder = shippingOrder as Order;
        } else {
          errors.push('Failed to set shipping address');
        }
      } else {
        errors.push(`Shipping address error: ${shippingResult.reason}`);
      }

      // Process billing address result (if applicable)
      if (billingAddress) {
        const billingResult = results[1];
        if (billingResult.status === 'fulfilled') {
          const billingOrder = billingResult.value;
          if (billingOrder.__typename === 'Order') {
            finalOrder = billingOrder as Order;
          } else {
            errors.push('Failed to set billing address');
          }
        } else {
          errors.push(`Billing address error: ${billingResult.reason}`);
        }
      }

      // Set shipping method using hardcoded logic (efficient, no GraphQL query needed)
      if (finalOrder) {
        try {
          const updatedOrder = await setOrderShippingMethodMutation([shippingMethodId]);
          if (updatedOrder && updatedOrder.__typename === 'Order') {
            finalOrder = updatedOrder;
            shippingMethodsApplied = true;
          } else {
            errors.push('Failed to set shipping method - invalid response');
          }
        } catch (shippingMethodError) {
          errors.push(`Failed to set shipping method: ${shippingMethodError}`);
        }
      }

      if (!finalOrder) {
        throw new Error('Failed to process checkout operations');
      }

      return {
        order: finalOrder,
        shippingMethodsApplied,
        errors
      };

    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'Unknown error occurred');
      const parallelError = new Error(`Parallel checkout processing failed: ${errors.join(', ')}`) as Error & { cause?: unknown };
      parallelError.cause = error;
      throw parallelError;
    }
  }

  /**
   * Fallback to sequential processing if parallel processing fails
   */
  static async processAddressAndShippingSequential(
    shippingAddress: AddressInput,
    billingAddress?: BillingAddressInput,
    orderSubTotal: number = 0
  ): Promise<ParallelCheckoutResult> {
    const errors: string[] = [];
    let shippingMethodsApplied = false;

    try {
      // 1. Set shipping address first
      const shippingResult = await setOrderShippingAddressMutation(shippingAddress);
      if (shippingResult.__typename === 'Order') {
        let finalOrder = shippingResult as Order;

        // 2. Set billing address if different
        if (billingAddress) {
          const billingResult = await setOrderBillingAddressMutation(billingAddress);
          if (billingResult.__typename === 'Order') {
            finalOrder = billingResult as Order;
          } else {
            errors.push('Failed to set billing address');
          }
        }

        // 3. Set shipping method using efficient hardcoded logic
        const shippingMethodId = (shippingAddress.countryCode === 'US' || shippingAddress.countryCode === 'PR')
          ? (orderSubTotal >= 10000 ? '6' : '3')
          : '7';

        try {
          const updatedOrder = await setOrderShippingMethodMutation([shippingMethodId]);
          if (updatedOrder && updatedOrder.__typename === 'Order') {
            finalOrder = updatedOrder;
            shippingMethodsApplied = true;
          } else {
            errors.push('Failed to set shipping method - invalid response');
          }
        } catch (shippingMethodError) {
          errors.push(`Failed to set shipping method: ${shippingMethodError}`);
        }

        return {
          order: finalOrder,
          shippingMethodsApplied,
          errors
        };
      } else {
        throw new Error('Failed to set shipping address');
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'Unknown error occurred');
      const sequentialError = new Error(`Sequential checkout processing failed: ${errors.join(', ')}`) as Error & { cause?: unknown };
      sequentialError.cause = error;
      throw sequentialError;
    }
  }

  /**
   * Main entry point that tries parallel processing first, falls back to sequential
   */
  static async optimizedCheckoutProcessing(
    shippingAddress: AddressInput,
    billingAddress?: BillingAddressInput,
    orderSubTotal: number = 0
  ): Promise<ParallelCheckoutResult> {
    try {
      // Try parallel processing first
      return await this.processAddressAndShippingParallel(
        shippingAddress,
        billingAddress,
        orderSubTotal
      );
    } catch (parallelError) {
      console.warn('Parallel processing failed, falling back to sequential:', parallelError);
      
      // Fallback to sequential processing
      return await this.processAddressAndShippingSequential(
        shippingAddress,
        billingAddress,
        orderSubTotal
      );
    }
  }
}
