// Extended Order types to handle API responses correctly
import { CurrencyCode, Maybe } from '~/generated/graphql-shop';
import type { OrderAddress } from '~/generated/graphql-shop';

// This simplified Customer type matches what's returned from the API
export interface CustomerResponse {
  __typename?: 'Customer';
  id: string;
  firstName: string;
  lastName: string;
  emailAddress: string;
  phoneNumber?: string;
}

// Define the actual shape that comes back from GraphQL API responses
export interface OrderResponse {
  __typename: 'Order';
  id: string;
  code: string;
  active: boolean;
  createdAt: any;
  state: string;
  currencyCode: CurrencyCode;
  totalQuantity: number;
  subTotal: any;
  subTotalWithTax: any;
  shipping: any;
  shippingWithTax: any;
  total: any;
  totalWithTax: any;
  customer?: Maybe<CustomerResponse>;
  shippingAddress?: Maybe<OrderAddress>;
  billingAddress?: Maybe<OrderAddress>;
  lines: any[];
  shippingLines: any[];
  updatedAt: any;
  [key: string]: any; // For any other fields returned by the API
}
