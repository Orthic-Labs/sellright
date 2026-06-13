import { server$ } from '@qwik.dev/router';
import { isBrowser } from '@qwik.dev/core/build';
import type { DocumentTypeDecoration } from '@graphql-typed-document-node/core';
import { AUTH_TOKEN, DEV_API, HEADER_AUTH_TOKEN_KEY, PROD_API } from '~/constants';
import { getCookie, setCookie } from '.';

export interface RequesterOptions {
	channelToken?: string;
	token?: string;
	apiUrl?: string;
}

type ResponseProps<T> = { token: string; data: T };
type ExecuteProps<V> = { query: string; variables?: V };
type Options = { method: string; headers: Record<string, string>; body: string };

const normalizeApiUrl = (value: string) => {
	const raw = value.trim().replace(/`/g, '');
	const withoutTrailingSlash = raw.replace(/\/+$/g, '');
	return withoutTrailingSlash.replace(/\.+$/g, '');
};

const baseUrl = normalizeApiUrl(import.meta.env.DEV ? DEV_API : PROD_API);
const shopApi = `${baseUrl}/shop-api`;

export const requester = async <R, V>(
	doc: DocumentTypeDecoration<R, V>,
	vars?: V,
	options: RequesterOptions = { token: '', apiUrl: shopApi, channelToken: '' }
): Promise<R> => {
	options.apiUrl = normalizeApiUrl(options?.apiUrl ?? shopApi);
	return execute<R, V>({ query: String(doc), variables: vars }, options);
};

const execute = async <R, V = Record<string, any>>(
	body: ExecuteProps<V>,
	options: RequesterOptions
): Promise<R> => {
	const requestOptions = {
		method: 'POST',
		headers: createHeaders(),
		body: JSON.stringify(body),
	};
	if (options.token) {
		requestOptions.headers = {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${options.token ?? ''}`,
		};
	}
	if (options.channelToken) {
		requestOptions.headers['vendure-token'] = options.channelToken;
	}

	const response: ResponseProps<R> =
		// Force client-side execution for localhost URLs (dev and prod) or development mode
		options.apiUrl?.includes('localhost') || import.meta.env.DEV
			? await executeRequest(requestOptions, options.apiUrl!)
			: isBrowser
				? await executeOnTheServer(requestOptions, options.apiUrl!)
				// SSR/SSG: public domain is locked down; rewrite to localhost.
				: await executeRequest(requestOptions, 'http://localhost:3100/shop-api');

	if (isBrowser && response.token) {
		// SECURITY (ra-004 partial): Use a short 1-day expiry instead of 365 days so
		// anonymous/session tokens don't persist indefinitely in the JS-readable cookie.
		// Authenticated customer tokens are refreshed on every request that returns a
		// new token, so the effective session length is unaffected for active users.
		// Full fix (httpOnly server-proxy) is deferred — see findings_deferred ra-004.
		setCookie(AUTH_TOKEN, response.token, 1);
	}

	return response.data;
};

const createHeaders = () => {
	let headers: Record<string, string> = { 'Content-Type': 'application/json' };

	if (isBrowser) {
		const token = getCookie(AUTH_TOKEN);
		headers = { ...headers, Authorization: `Bearer ${token}` };

		// 🚀 Add customer context headers for backend logging and security
		// Only add these headers in the browser to avoid SSR issues
		try {
			headers = { ...headers, ...getCustomerContextHeaders() };
		} catch (error) {
			console.warn('Error adding customer context headers:', error);
		}
	}

	return headers;
};

/**
 * 🚀 Extract real customer context for backend logging and security
 * This helps the backend distinguish between legitimate customer requests and bot requests
 * IMPORTANT: Only call this in browser environment to avoid SSR issues
 */
const getCustomerContextHeaders = (): Record<string, string> => {
	const customerHeaders: Record<string, string> = {};

	// 🚀 SAFETY: Only extract customer context in browser environment
	if (!isBrowser || typeof window === 'undefined') {
		return customerHeaders; // Return empty headers for server-side
	}

	try {
		// 1. Real customer IP (client-side detection is limited)
		customerHeaders['x-customer-ip'] = 'client-side-unknown';

		// 2. Real customer user agent
		if (typeof navigator !== 'undefined' && navigator.userAgent) {
			customerHeaders['x-customer-user-agent'] = navigator.userAgent;
		}

		// 3. Customer session information (safe to call in browser)
		try {
			const sessionId = getCookie('vendure-session') || getCookie('session') || 'unknown';
			customerHeaders['x-session-id'] = sessionId;
		} catch (_e) {
			customerHeaders['x-session-id'] = 'unknown';
		}

		// 4. Customer authentication status
		try {
			const authToken = getCookie(AUTH_TOKEN);
			customerHeaders['x-customer-authenticated'] = authToken ? 'true' : 'false';
		} catch (_e) {
			customerHeaders['x-customer-authenticated'] = 'false';
		}

		// 5. Page context (safe window access)
		if (window.location) {
			customerHeaders['x-customer-page'] = window.location.pathname || 'unknown';
		}
		if (document && document.referrer !== undefined) {
			customerHeaders['x-customer-referer'] = document.referrer || 'direct';
		}

		// 6. Timestamp for request correlation
		customerHeaders['x-customer-timestamp'] = Date.now().toString();

		// 7. Browser language and timezone (safe navigator access)
		if (typeof navigator !== 'undefined') {
			if (navigator.language) {
				customerHeaders['x-customer-language'] = navigator.language;
			}
			try {
				customerHeaders['x-customer-timezone'] = Intl.DateTimeFormat().resolvedOptions().timeZone;
			} catch (_e) {
				customerHeaders['x-customer-timezone'] = 'unknown';
			}
		}

	} catch (error) {
		console.warn('Error extracting customer context:', error);
		customerHeaders['x-customer-context-error'] = 'true';
	}

	return customerHeaders;
};

const executeOnTheServer = server$(async (options: Options, _apiUrl: string) => {
	const internalUrl = 'http://localhost:3100/shop-api';
	return executeRequest(options, internalUrl);
});

const executeRequest = async (options: Options, apiUrl: string) => {
	try {
		const normalizedUrl = normalizeApiUrl(apiUrl);
		const httpResponse = await fetch(normalizedUrl, options);
		if (!httpResponse.ok) {
			throw new Error(`HTTP error! status: ${httpResponse.status}`);
		}
		return await extractTokenAndData(httpResponse, normalizedUrl);
	} catch (error) {
		console.error(`Could not fetch from ${apiUrl}. Reason: ${error}`);
		throw error;
	}
};

const extractTokenAndData = async (response: Response, apiUrl: string) => {
	if (response.body === null) {
		console.error(`Emtpy request body for a call to ${apiUrl}`);
		return { token: '', data: {} };
	}
	const token = response.headers.get(HEADER_AUTH_TOKEN_KEY) || '';
	const { data, errors } = await response.json();
	if (errors && !data) {
		// e.g. API access related errors, like auth issues.
		throw new Error(errors[0].message);
	}
	return { token, data };
};
