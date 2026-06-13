import {
	DEFAULT_METADATA_DESCRIPTION,
	DEFAULT_METADATA_IMAGE,
	DEFAULT_METADATA_TITLE,
	DEFAULT_METADATA_URL,
	DEFAULT_CURRENCY,
} from '~/constants';
import { ENV_VARIABLES } from '~/env';
import { SearchResponse } from '~/generated/graphql-shop';
import { ActiveCustomer, FacetWithValues } from '~/types';

export const getRandomInt = (max: number) => Math.floor(Math.random() * max);

export function formatPrice(value = 0, currencyCode?: string) {
	const amount = value / 100;
	const hasDecimals = amount % 1 !== 0;
	return new Intl.NumberFormat('en-US', {
		style: 'currency',
		currency: currencyCode || DEFAULT_CURRENCY,
		minimumFractionDigits: hasDecimals ? 2 : 0,
		maximumFractionDigits: hasDecimals ? 2 : 0,
	}).format(amount);
}

export function formatCustomPrice(value = 0, currencyCode?: string) {
	return new Intl.NumberFormat('en-US', {
		style: 'currency',
		currency: currencyCode || DEFAULT_CURRENCY,
		minimumFractionDigits: 0,
		maximumFractionDigits: 0,
	}).format(value);
}

export const groupFacetValues = (
	search: SearchResponse,
	activeFacetValueIds: string[]
): FacetWithValues[] => {
	if (!search) {
		return [];
	}
	const facetMap = new Map<string, FacetWithValues>();
	for (const {
		facetValue: { id, name, facet },
		count,
	} of search.facetValues) {
		if (count === search.totalItems) {
			continue;
		}
		const facetFromMap = facetMap.get(facet.id);
		const selected = (activeFacetValueIds || []).includes(id);
		if (facetFromMap) {
			facetFromMap.values.push({ id, name, selected });
		} else {
			facetMap.set(facet.id, {
				id: facet.id,
				name: facet.name,
				open: true,
				values: [{ id, name, selected }],
			});
		}
	}
	return Array.from(facetMap.values());
};

export const enableDisableFacetValues = (_facetValues: FacetWithValues[], ids: string[]) => {
	const facetValueIds: string[] = [];
	const facetValues = _facetValues.map((facet) => {
		facet.values = facet.values.map((value) => {
			if (ids.includes(value.id)) {
				facetValueIds.push(value.id);
				value.selected = true;
			} else {
				value.selected = false;
			}
			return value;
		});
		return facet;
	});
	return { facetValues, facetValueIds };
};

export const changeUrlParamsWithoutRefresh = (collectionSlug: string, facetValueIds: string[], term: string) => {
  const params = new URLSearchParams();
  if (term) {
    params.set('q', term);
  }
  if (facetValueIds && facetValueIds.length > 0) {
    params.set('f', facetValueIds.join('-'));
  }
  if (collectionSlug) {
    params.set('c', collectionSlug);
  }

  const queryString = params.toString();
  const newUrl = `${window.location.origin}${window.location.pathname}${queryString ? `?${queryString}` : ''}`;

  return window.history.pushState('', '', newUrl);
};

// SECURITY NOTE (ra-004): This cookie holds the Vendure auth token and is JS-readable
// (not HttpOnly). This is a residual XSS risk: any injected script on the page can
// exfiltrate the token. The full fix (httpOnly + server-side token proxy) is a ~4h
// architectural change deferred to a dedicated session — see findings_deferred ra-004.
// Safe subset applied here: Secure+SameSite=Strict enforced on https, short expiry for
// anonymous/session tokens.
export const setCookie = (name: string, value: string, days: number) => {
	let expires = '';
	if (days) {
		const date = new Date();
		date.setTime(date.getTime() + days * 24 * 60 * 60 * 1000);
		expires = '; expires=' + date.toUTCString();
	}
	// Always enforce Secure+SameSite=Strict when running over HTTPS (production).
	// VITE_SECURE_COOKIE=true also enables this for non-https dev tunnels if needed.
	const isHttps =
		typeof window !== 'undefined' && window.location.protocol === 'https:';
	const secureCookie =
		isHttps || isEnvVariableEnabled('VITE_SECURE_COOKIE')
			? ' Secure; SameSite=Strict;'
			: '';
	document.cookie = name + '=' + (value || '') + expires + `;${secureCookie} path=/`;
};

export const getCookie = (name: string) => {
	const keyValues = document.cookie.split(';');
	let result = '';
	keyValues.forEach((item) => {
		const eqIndex = item.indexOf('=');
		if (eqIndex === -1) return;
		const key = item.substring(0, eqIndex).trim();
		const value = item.substring(eqIndex + 1);
		if (key === name) {
			result = value;
		}
	});
	return result;
};

export const cleanUpParams = (params: Record<string, string>) => {
	if ('slug' in params && params.slug[params.slug.length - 1] === '/') {
		params.slug = params.slug.slice(0, params.slug.length - 1);
	}
	return params;
};

export const isEnvVariableEnabled = (envVariable: keyof typeof ENV_VARIABLES) =>
	ENV_VARIABLES[envVariable] === 'true';

export const fullNameWithTitle = ({
	title,
	firstName,
	lastName,
}: Pick<ActiveCustomer, 'title' | 'firstName' | 'lastName'>): string => {
	return [title, firstName, lastName].filter((x) => !!x).join(' ');
};

export const formatDateTime = (dateToConvert: Date) => {
	const result = new Date(dateToConvert).toISOString();
	const [date, time] = result.split('T');
	const [hour, minutes] = time.split(':');
	const orderedDate = date.split('-').reverse().join('-');
	return `${orderedDate} ${hour}:${minutes}`;
};

export const generateDocumentHead = (
	url = DEFAULT_METADATA_URL,
	title = DEFAULT_METADATA_TITLE,
	description = DEFAULT_METADATA_DESCRIPTION,
	image = DEFAULT_METADATA_IMAGE
) => {
	const OG_METATAGS = [
		{ property: 'og:type', content: 'website' },
		{ property: 'og:url', content: url },
		{ property: 'og:title', content: title },
		{
			property: 'og:description',
			content: description,
		},
		{
			property: 'og:image',
			content: image ? image + '?preset=xl' : undefined,
		},
	];
	const TWITTER_METATAGS = [
		{ property: 'twitter:card', content: 'summary_large_image' },
		{ property: 'twitter:url', content: url },
		{ property: 'twitter:title', content: title },
		{
			property: 'twitter:description',
			content: description,
		},
		{
			property: 'twitter:image',
			content: image ? image + '?preset=xl' : undefined,
		},
	];
	return { title, meta: [...OG_METATAGS, ...TWITTER_METATAGS] };
};
