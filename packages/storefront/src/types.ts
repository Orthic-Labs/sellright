import type { Live } from '~/sellright/types/live';

export type BillingAddress = Live & {
  firstName?: string;
  lastName?: string;
  streetLine1?: string;
  streetLine2?: string;
  city?: string;
  province?: string;
  postalCode?: string;
  countryCode?: string;
};

export type AppState = Live & {
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
	/** The latest server shipping quote's free-shipping tier (see `cart.free-shipping-progress`); null until quoted. */
	freeShipping?: { threshold: number; remaining: number } | null;
};

export type ShippingAddress = Live & {
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

export type ActiveCustomer = Live & {
	title?: string;
	firstName: string;
	id: string;
	lastName: string;
	emailAddress?: string;
	phoneNumber?: string;
};

export type EligibleShippingMethods = {
	id: string;
	name: string;
	price: number;
	priceWithTax: number;
};

export type Country = {
	id: string;
	code: string;
	name: string;
};
