import { ssrRenderToDom, trigger } from '@qwik.dev/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BRAND_HEAD } from '~/platform/brand-data';
import { YouTubeFacade } from './YouTubeFacade';

vi.mock('~/platform/brand-data', () => ({ BRAND_HEAD: { embeds: { youtube: true } } }));
beforeEach(() => { BRAND_HEAD.embeds = { youtube: true }; });
afterEach(() => { delete BRAND_HEAD.embeds; });

describe('YouTubeFacade after SSR & resumption', () => {
	it('renders a real no-JS watch link & thumbnail, then creates only the privacy frame after click', async () => {
		const { document } = await ssrRenderToDom(<YouTubeFacade id="Abc123_-xyz" title="Customer review" class="brand-video" />, {});
		expect(document.querySelector('iframe') ?? null).toBeNull();
		expect(document.querySelector('svg')?.getAttribute('width')).toBe('68');
		expect(document.querySelector('svg')?.getAttribute('height')).toBe('48');
		expect(document.querySelector('rect')?.getAttribute('fill')).toBe('#f00');
		expect(document.querySelector('.brand-video')).toBeTruthy();
		const link = document.querySelector('.sr-youtube-facade');
		expect(link?.getAttribute('href')).toBe('https://www.youtube.com/watch?v=Abc123_-xyz');
		expect(link?.getAttribute('aria-label')).toBe('Play Customer review on YouTube');
		expect(document.querySelector('img')?.getAttribute('src')).toBe('https://i.ytimg.com/vi/Abc123_-xyz/hqdefault.jpg');
		expect(document.querySelector('script[src*="youtube"]') ?? null).toBeNull();
		await trigger(document.body, '.sr-youtube-facade', 'click');
		const frame = document.querySelector('iframe');
		expect(frame?.getAttribute('src')).toBe('https://www.youtube-nocookie.com/embed/Abc123_-xyz?autoplay=1&rel=0');
		expect(frame?.getAttribute('title')).toBe('Customer review');
		expect(frame?.getAttribute('allow')).toBe('autoplay; fullscreen');
		expect(frame?.hasAttribute('allowfullscreen')).toBe(true);
	});
	it('classic opts into exact fixed legacy geometry with a CSS-colorable surface & the same click boundary', async () => {
		const { document } = await ssrRenderToDom(<YouTubeFacade id="Abc123_-xyz" title="Review" appearance="classic" />, {});
		const glyph = document.querySelector('.sr-youtube-play svg');
		expect(glyph?.getAttribute('width')).toBe('56');
		expect(glyph?.getAttribute('height')).toBe('40');
		expect(glyph?.getAttribute('viewBox')).toBe('0 0 68 48');
		expect(glyph?.querySelector('rect') ?? null).toBeNull();
		const surface = glyph?.querySelector('.sr-youtube-play-surface');
		expect(surface?.getAttribute('fill')).toBe('currentColor');
		expect(surface?.getAttribute('d')).toBe('M66.5 7.5a8 8 0 0 0-5.6-5.7C56 .5 34 .5 34 .5s-22 0-26.9 1.3A8 8 0 0 0 1.5 7.5 83.7 83.7 0 0 0 .2 24a83.7 83.7 0 0 0 1.3 16.5 8 8 0 0 0 5.6 5.7C12 47.5 34 47.5 34 47.5s22 0 26.9-1.3a8 8 0 0 0 5.6-5.7A83.7 83.7 0 0 0 67.8 24a83.7 83.7 0 0 0-1.3-16.5z');
		expect(glyph?.querySelector('path:last-child')?.getAttribute('fill')).toBe('#fff');
		expect(glyph?.querySelector('path:last-child')?.getAttribute('d')).toBe('M27 34l18-10-18-10z');
		expect(document.querySelector('iframe') ?? null).toBeNull();
		expect(document.querySelector('a')?.getAttribute('href')).toBe('https://www.youtube.com/watch?v=Abc123_-xyz');
		await trigger(document.body, '.sr-youtube-facade', 'click');
		expect(document.querySelector('iframe')?.getAttribute('src')).toBe('https://www.youtube-nocookie.com/embed/Abc123_-xyz?autoplay=1&rel=0');
		expect(document.querySelector('iframe')?.getAttribute('allow')).toBe('autoplay; fullscreen');
	});
	it('keeps only the watch fallback when head.json has not opted in, even after click', async () => {
		delete BRAND_HEAD.embeds;
		const { document } = await ssrRenderToDom(<YouTubeFacade id="Abc123_-xyz" title="Review" />, {});
		expect(document.querySelector('a')?.getAttribute('href')).toContain('https://www.youtube.com/watch?v=');
		expect(document.querySelector('a')?.hasAttribute('preventdefault:click')).toBe(false);
		await trigger(document.body, '.sr-youtube-facade', 'click');
		expect(document.querySelector('iframe') ?? null).toBeNull();
	});
	it('renders no provider URL, image, play control or frame for invalid ids', async () => {
		const { document } = await ssrRenderToDom(<YouTubeFacade id="//evil.test" title="Unavailable review" />, {});
		expect(document.querySelector('a, img, iframe') ?? null).toBeNull();
		expect(document.body.textContent).toContain('Unavailable review');
	});
});
