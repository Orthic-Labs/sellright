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
