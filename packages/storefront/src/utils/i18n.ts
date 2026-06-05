/**
 * Simplified i18n utility for English-only support
 */
import { loadTranslations } from '@angular/localize';
import '@angular/localize/init';
import { withLocale } from '@qwik.dev/core';
import { DEFAULT_LOCALE } from '~/constants';
import EN from '../locales/message.en.json';

/**
 * Function used to load English translations only.
 */
export function initTranslations() {
	console.log('Loading English translations...');
	withLocale(EN.locale, () => loadTranslations(EN.translations));
}

/**
 * Returns English locale always since we only support English.
 */
export function extractLang(): string {
	return DEFAULT_LOCALE;
}

/**
 * Returns build path without locale since we only support English.
 */
export function extractBase(): string {
	return '/build';
}

export function useI18n() {
	// Runtime translation is used during development only.
	if (import.meta.env.DEV) {
		return initTranslations;
	}
	// Otherwise, will return a noop
	return () => {};
}

// Commented out to eliminate translations system logging
// initTranslations();
