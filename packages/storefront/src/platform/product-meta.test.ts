import { describe, expect, it } from 'vitest';
import { plainMetaText, productMetaDescription } from './product-meta';

describe('plainMetaText', () => {
	it('drops tags and the whole SPECS dump, decodes entities and plain-quotes typographic ones', () => {
		const html = '<p>The Oni is a “small” knife&nbsp;for ‘EDC’.</p><p>SPECS</p><p>Blade Material: Sandvik 14c28n.<br>Handle Material: G10</p>';
		expect(plainMetaText(html)).toBe('The Oni is a "small" knife for \'EDC\'.');
	});

	it('is empty for no description', () => {
		expect(plainMetaText(undefined)).toBe('');
		expect(plainMetaText('<p>SPECS</p><p>Weight: 3oz</p>')).toBe('');
	});
});

describe('productMetaDescription', () => {
	const long = 'The Oni is a small but mighty knife that offers you the perfect mix of versatility, capability and practicality. With a closed length of 3 inches and weighing about 2.8 ounces, the Oni is perfect for everyday carry.';

	it('uses a description of 70-160 characters as is, never the SPECS block', () => {
		const text = 'A sturdy folding knife with a 3 inch tanto blade, built for everyday carry and daily tasks.';
		const out = productMetaDescription({ name: 'Oni', description: `<p>${text}</p><p>SPECS</p><p>Blade Material: 14c28n</p>` }, 'Acme');
		expect(out).toBe(text);
		expect(out).not.toMatch(/SPECS|Blade Material/);
	});

	it('cuts a long description at a word near 160 characters with an ellipsis', () => {
		const out = productMetaDescription({ name: 'Oni', description: `<p>${long}</p>` }, 'Acme');
		expect(out.length).toBeLessThanOrEqual(161);
		expect(out.endsWith('…')).toBe(true);
		expect(long.startsWith(out.slice(0, -1))).toBe(true);
	});

	it('pads a thin description with the name, category phrase and store name only', () => {
		expect(productMetaDescription({ name: 'Oni', description: '<p>Small blade.</p>', tags: ['folding knives'] }, 'Acme')).toBe('Oni — Small blade. EDC folding knife from Acme.');
		expect(productMetaDescription({ name: 'Oni', description: null, tags: ['folding knives'] }, 'Acme')).toBe('Oni — EDC folding knife from Acme.');
	});

	it('uses the product\'s own tag for an unmapped category, and no category when it has none', () => {
		expect(productMetaDescription({ name: 'Mug', description: null, tags: ['Drinkware'] }, 'Acme')).toBe('Mug — drinkware from Acme.');
		expect(productMetaDescription({ name: 'Mug', description: null }, 'Acme')).toBe('Mug — Available from Acme.');
	});

	it('copes with a missing product', () => {
		expect(productMetaDescription(null, 'Acme')).toBe('Product — Available from Acme.');
	});
});
