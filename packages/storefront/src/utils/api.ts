import { server$ } from '@qwik.dev/router';
import { isBrowser } from '@qwik.dev/core/build';
import type { DocumentTypeDecoration } from '@graphql-typed-document-node/core';
import { AUTH_TOKEN, DEV_API, HEADER_AUTH_TOKEN_KEY, PROD_API } from '~/constants';

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
	const headers = createHeaders();
	if (options.token) {
		headers.Authorization = `Bearer ${options.token}`;
	}
	if (options.channelToken) {
		headers['vendure-token'] = options.channelToken;
	}

	const requestOptions = {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
	};

	const response: ResponseProps<R> = isBrowser
		? await executeOnTheServer(requestOptions)
		: await executeRequest(requestOptions, options.apiUrl?.includes('localhost') ? options.apiUrl : 'http://localhost:3100/shop-api');

	return response.data;
};

const createHeaders = () => {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };

	return headers;
};

const executeOnTheServer = server$(async function (this, options: Options) {
	const internalUrl = 'http://localhost:3100/shop-api';
	const token = this.cookie.get(AUTH_TOKEN)?.value;

	if (token && !options.headers.Authorization) {
		options.headers.Authorization = `Bearer ${token}`;
	}

	const response = await executeRequest(options, internalUrl);

	if (response.token) {
		this.cookie.set(AUTH_TOKEN, response.token, {
			path: '/',
			httpOnly: true,
			sameSite: 'Strict',
			secure: this.url.protocol === 'https:',
			maxAge: [1, 'days'],
		});
	}

	return { data: response.data, token: '' };
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
