import { describe, expect, it } from 'vitest';
import { generateImagePreloadLinks, generateResponsiveSources, RESPONSIVE_CONFIGS } from './LazyImage';

const SRC = '/assets/store/media/preview/09/photo__preview.png';

describe('responsive image presets (real preset widths)', () => {
	it('PDP main: 375px slot at 2x resolves to medium, never xl; max preset is large', () => {
		const set = generateResponsiveSources(SRC, RESPONSIVE_CONFIGS.productMain.widths).avifSrcset!;
		expect(set).toContain('preset=small&format=avif');
		expect(set).toContain('preset=medium&format=avif');
		expect(set).toContain('preset=large&format=avif');
		expect(set).not.toMatch(/preset=(xl|xxl)/);
		expect(set).toMatch(/preset=medium[^,]* 819w/);
	});

	it('product card: small + medium only', () => {
		const set = generateResponsiveSources(SRC, RESPONSIVE_CONFIGS.productCard.widths).webpSrcset!;
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
