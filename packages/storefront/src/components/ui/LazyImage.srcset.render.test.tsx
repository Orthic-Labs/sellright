import { describe, expect, it } from 'vitest';
import { generateImagePreloadLinks, generateResponsiveSources, RESPONSIVE_CONFIGS } from './LazyImage';

const SRC = '/assets/store/media/preview/09/photo__preview.png';

describe('responsive image presets (real preset widths)', () => {
	it('PDP main: each width maps to the preset that has it, up to xxl (1638w); variant revision on every URL (#425)', () => {
		const set = generateResponsiveSources(SRC, RESPONSIVE_CONFIGS.productMain.widths).avifSrcset!;
		expect(set).toMatch(/preset=medium[^,]* 819w/);
		expect(set).toMatch(/preset=large[^,]* 1024w/);
		expect(set).toMatch(/preset=xl[^,]* 1280w/);
		expect(set).toMatch(/preset=xxl[^,]* 1638w/);
		expect(set).not.toContain('preset=ultra');
		for (const entry of set.split(', ')) expect(entry).toContain('&r=');
		expect(RESPONSIVE_CONFIGS.productMain.sizes).toBe('(max-width: 768px) 100vw, 1024px');
	});

	it('product card: small + medium only', () => {
		const set = generateResponsiveSources(SRC, RESPONSIVE_CONFIGS.productCard.widths).webpSrcset!;
		expect(set).toMatch(/preset=small[^,]* 512w/);
		expect(set).toMatch(/preset=medium[^,]* 819w/);
		expect(set).not.toContain('preset=large');
	});

	it('PDP related card: card for phones (320w), small and medium for desktop; never large (audit 2026-11-02)', () => {
		const set = generateResponsiveSources(SRC, RESPONSIVE_CONFIGS.relatedCard.widths).avifSrcset!;
		expect(set).toMatch(/preset=card[^,]* 320w/);
		expect(set).toMatch(/preset=small[^,]* 512w/);
		expect(set).toMatch(/preset=medium[^,]* 819w/);
		expect(set).not.toContain('preset=large');
	});

	it('thumbnail: thumb + card (no small)', () => {
		const set = generateResponsiveSources(SRC, RESPONSIVE_CONFIGS.thumbnail.widths).avifSrcset!;
		expect(set).toContain('preset=thumb');
		expect(set).toContain('preset=card');
		expect(set).not.toContain('preset=small');
	});

	it('avif-only preload yields exactly one link, same URLs as the avif <source>', () => {
		const links = generateImagePreloadLinks(SRC, 'productMain', ['avif']);
		expect(links).toHaveLength(1);
		expect(links[0].imagesrcset).toBe(generateResponsiveSources(SRC, RESPONSIVE_CONFIGS.productMain.widths).avifSrcset);
		expect(links[0].imagesizes).toBe(RESPONSIVE_CONFIGS.productMain.sizes);
	});
});

describe('generateImagePreloadLinks priority (#429)', () => {
	it('every LCP preload is fetchpriority high', () => {
		const links = generateImagePreloadLinks(SRC, 'productMain', ['avif', 'webp', 'original']);
		expect(links.length).toBe(3);
		for (const l of links) expect(l.fetchpriority).toBe('high');
	});
});
