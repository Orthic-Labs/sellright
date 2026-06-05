import { server$ } from '@qwik.dev/router';
import { Order } from '~/generated/graphql-shop';
import { TrackOrderDocument, type TrackOrderQuery, type TrackOrderQueryVariables } from '~/generated/graphql-shop-typed';
import { requester } from '~/utils/api';

export interface OrderTrackingResult {
  order?: Order;
  error?: string;
  success: boolean;
}

/**
 * Shared server function to track order via GraphQL
 */
export const trackOrderServer = server$(async (orderCode: string, email: string): Promise<OrderTrackingResult> => {
  try {
    const result = await requester<TrackOrderQuery, TrackOrderQueryVariables>(TrackOrderDocument, { orderCode, email });
    return result.trackOrder as unknown as OrderTrackingResult;
  } catch (error) {
    console.error('Order tracking error:', error);
    return {
      success: false,
      error: 'Unable to track order at this time. Please try again later.',
    };
  }
});
