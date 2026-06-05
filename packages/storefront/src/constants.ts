import { createContextId } from '@qwik.dev/core';
import { ENV_VARIABLES } from './env';
import { AppState } from './types';
export const APP_STATE = createContextId<AppState>('app_state');
export const AUTH_TOKEN = 'authToken';
export const COUNTRY_COOKIE = 'countryCode';
export const CUSTOMER_NOT_DEFINED_ID = 'CUSTOMER_NOT_DEFINED_ID';
export const HEADER_AUTH_TOKEN_KEY = 'vendure-auth-token';
export const IMAGE_RESOLUTIONS = [1000, 800, 600, 400];
export const HOMEPAGE_IMAGE = '/homepage.webp';
export const DEFAULT_METADATA_URL = 'https://www.damneddesigns.com/';
export const DEFAULT_METADATA_TITLE = 'Damned Designs';
export const DEFAULT_METADATA_DESCRIPTION =
	'Premium quality products and exceptional service at Damned Designs';
export const DEFAULT_METADATA_IMAGE = 'https://www.damneddesigns.com/logo.svg';
export const DEFAULT_LOCALE = 'en';
export const DEFAULT_CURRENCY = 'USD';
const normalizeApiUrl = (value: string | undefined, fallback: string) => {
	const raw = (value || '').trim().replace(/`/g, '');
	const withoutTrailingSlash = raw.replace(/\/+$/g, '');
	const normalized = withoutTrailingSlash.replace(/\.+$/g, '');
	return normalized || fallback;
};

export const DEV_API = normalizeApiUrl(ENV_VARIABLES.VITE_VENDURE_DEV_URL, 'http://localhost:3100');
export const PROD_API = normalizeApiUrl(ENV_VARIABLES.VITE_VENDURE_PROD_URL, 'http://localhost:3100');
export const LOCAL_API = normalizeApiUrl(ENV_VARIABLES.VITE_VENDURE_LOCAL_URL, 'http://localhost:3100');





