import { Order as OrderGql, Collection as CollectionGql } from '~/generated/graphql-shop';
import type { CurrencyCode } from '~/generated/graphql-shop';

export type BillingAddress = {
  firstName?: string;
  lastName?: string;
  streetLine1?: string;
  streetLine2?: string;
  city?: string;
  province?: string;
  postalCode?: string;
  countryCode?: string;
};

export type AppState = {
	collections: CollectionGql[];
	activeOrder: Order;
	showCart: boolean;
	showMenu: boolean;
	showUserMenu: boolean;
	showMobileUserMenu: boolean;
	isLoading: boolean;
	customer: ActiveCustomer;
	shippingAddress: ShippingAddress;
	billingAddress: BillingAddress;
	availableCountries: Country[];
	addressBook: ShippingAddress[];
	isPageTransitionLoading?: boolean;
};

export type Product = {
	id: string;
	name: string;
	slug?: string;
	description: string;
	collections: Collection[];
	facetValues: FacetValue[];
	featuredAsset: FeaturedAsset;
	assets: Asset[];
	variants: Variant[];
	optionGroups: ProductOptionGroup[];
};

type Breadcrumb = {
	id: string;
	name: string;
	slug: string;
};

export type Collection = {
	id: string;
	slug: string;
	name: string;
	breadcrumbs?: Breadcrumb[];
	parent?: { name: '__root_collection__' };
	featuredAsset?: { id: string; preview: string };
	children: any[];
};

type Facet = {
	id: string;
	code: string;
	name: string;
};

type FacetValue = {
	facet: Facet;
	id: string;
	code: string;
	name: string;
};

type FeaturedAsset = {
	id: string;
	preview: string;
};

type Asset = {
	id: string;
	preview: string;
};

export type ProductOptionGroup = {
	id: string;
	code: string;
	name: string;
	options: ProductOption[];
};

export type ProductOption = {
	id: string;
	code: string;
	name: string;
	group?: ProductOptionGroup;
};

export type Variant = {
	id: string;
	name: string;
	priceWithTax: number;
	price?: number;
	currencyCode: CurrencyCode;
	sku: string;
	stockLevel: string;
	trackInventory?: string | boolean;
	featuredAsset?: any;
	assets?: Array<{ id: string; preview: string; [key: string]: any }>;
	options: ProductOption[];
	customFields?: {
		salePrice?: number | null;
		preOrderPrice?: number | null;
		shipDate?: string | null;
	};
};

// activeOrder

type TaxSummary = {
	description: string;
	taxRate: number;
	taxTotal: number;
};

export type ShippingAddress = {
	id?: string;
	fullName?: string;
	streetLine1?: string;
	streetLine2?: string;
	company?: string;
	city?: string;
	province?: string;
	postalCode?: string;
	countryCode?: string;
	phoneNumber?: string;
	defaultShippingAddress?: boolean;
	defaultBillingAddress?: boolean;
	country?: string;
};

type ProductVariant = {
	id: string;
	name: string;
	price: number;
	product: Product;
};

export type Line = {
	id: string;
	unitPriceWithTax: number;
	linePriceWithTax: number;
	quantity: number;
	featuredAsset: FeaturedAsset;
	productVariant: ProductVariant;
};

export type ActiveOrder = {
	__typename: string;
	id: string;
	code: string;
	active: boolean;
	createdAt: Date;
	state: string;
	currencyCode: CurrencyCode;
	totalQuantity: number;
	subTotal: number;
	subTotalWithTax: number;
	taxSummary: TaxSummary[];
	shippingWithTax: number;
	totalWithTax: number;
	customer?: any;
	shippingAddress: ShippingAddress;
	shippingLines: ShippingLine[];
	lines: Line[];
	errorCode?: string;
};

export type OrderPriceFields = keyof Pick<
	ActiveOrder,
	'subTotal' | 'totalWithTax' | 'subTotalWithTax' | 'shippingWithTax'
>;

type ShippingLine = {
	priceWithTax: 1000;
	shippingMethod: { id: string; name: string };
};

// search

type ProductAsset = {
	id: string;
	preview: string;
};

type PriceWithTax = {
	value: number;
};

type Item = {
	productId: string;
	productName: string;
	slug: string;
	productAsset: ProductAsset;
	currencyCode: CurrencyCode;
	priceWithTax: PriceWithTax;
};

type FilterFacetValueDetail = {
	id: string;
	name: string;
	facet: Facet;
};

type FilterFacetValue = {
	count: number;
	facetValue: FilterFacetValueDetail;
};

export type Search = {
	totalItems: number;
	items: Item[];
	facetValues: FilterFacetValue[];
};

export type FacetWithValues = {
	id: string;
	name: string;
	open: boolean;
	values: Array<{
		id: string;
		name: string;
		selected: boolean;
	}>;
};

export type Review = {
	id: number;
	title: string;
	rating: number;
	content: string;
	author: string;
	date: string;
	datetime: string;
};

export type ActiveCustomer = {
	title?: string;
	firstName: string;
	id: string;
	lastName: string;
	emailAddress?: string;
	phoneNumber?: string;
};

export type Login = ActiveCustomer & {
	__typename: 'CurrentUser' | string;
	message: string;
};

export type RegisterCustomer = Omit<ActiveCustomer, 'id'> & {
	password: string;
	success?: boolean;
	message?: string;
};

export type EligibleShippingMethods = {
	id: string;
	name: string;
	price: number;
	priceWithTax: number;
};

export type EligiblePaymentMethods = {
	name: string;
	code: string;
	isEligible: boolean;
};

export type Country = {
	id: string;
	code: string;
	name: string;
};

export type ActiveCustomerOrders = {
	id: string;
	orders: {
		items: ActiveCustomerOrder[];
		totalItems: string;
	};
};

export type ActiveCustomerOrder = {
	id: string;
	code: string;
	state: string;
	totalWithTax: number;
	currencyCode: string;
	lines: {
		featuredAsset: {
			preview: string;
		};
		productVariant: { name: string };
	}[];
};

export type { CurrencyCode };

export type Order = OrderGql;
