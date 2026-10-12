import { describe, expect, it } from 'vitest';
import { addHeadingIdsAndToc, buildBlogBody, fixBodyHtml, rankRelatedPosts, slugify, tocFromSanitized } from './blog-content';
import { sanitizeBlogHtml, sanitizeHtml } from '~/utils/sanitize';
import { toSanitizedHtml } from './sanitized';

describe('addHeadingIdsAndToc (moved unchanged from the base page)', () => {
	it('adds slug ids to h2 elements, numbers duplicates, skips empty headings', () => {
		const { html, toc } = addHeadingIdsAndToc('<h2>Fit &amp; Care</h2><p>x</p><h2>Fit &amp; Care</h2><h2></h2><h3>Not toc</h3>');
		// stripHtml keeps entities escaped: the id and text are exactly what the base page always produced
		expect(toc).toEqual([{ id: 'fit-amp-care', text: 'Fit &amp; Care' }, { id: 'fit-amp-care-2', text: 'Fit &amp; Care' }]);
		expect(html).toContain('<h2 id="fit-amp-care">');
		expect(html).toContain('<h2 id="fit-amp-care-2">');
		expect(html).toContain('<h3>Not toc</h3>');
	});

	it('fixBodyHtml turns markdown-ish paragraphs into headings and rules', () => {
		expect(fixBodyHtml('<p>## Title</p><p>---</p>')).toBe('<h2>Title</h2><hr>');
	});

	it('slugify caps at 60 chars', () => {
		expect(slugify('A'.repeat(100))).toHaveLength(60);
	});
});

describe('the blog sanitiser policy', () => {
	it('keeps ids on h2 and h3 with a well-formed value', () => {
		const out = sanitizeBlogHtml('<h2 id="fit-care">Fit</h2><h3 id="sizing-guide">Sizing</h3>');
		expect(out).toContain('<h2 id="fit-care">');
		expect(out).toContain('<h3 id="sizing-guide">');
	});

	it('drops id on p, div, a and span, and on h4-h6', () => {
		const out = sanitizeBlogHtml('<p id="x">a</p><div id="y">b</div><a id="z" href="/q">c</a><span id="w">d</span><h4 id="h4">e</h4>');
		expect(out).not.toMatch(/\bid=/);
	});

	it('drops a clobbering id (id="location") and malformed or over-long ids even on h2', () => {
		for (const id of ['location', 'cookie', 'body', 'getElementById', 'Bad_Id', 'a b', '-x', 'x-', 'a'.repeat(81), '1;2', "x'y", '']) {
			expect(sanitizeBlogHtml(`<h2 id="${id}">T</h2>`), id).not.toMatch(/\bid=/);
		}
		expect(sanitizeBlogHtml(`<h2 id="${'a'.repeat(20)}">T</h2>`)).toContain('id=');
	});

	it('the hook is scoped to the call: the default sanitiser still strips every id afterwards', () => {
		sanitizeBlogHtml('<h2 id="ok">T</h2>');
		expect(sanitizeHtml('<h2 id="ok">T</h2>')).not.toMatch(/\bid=/);
		expect(sanitizeHtml('<h2 id="ok">T</h2>')).toBe('<h2>T</h2>');
	});

	it('still strips scripts, handlers and unknown tags like the default policy', () => {
		const out = sanitizeBlogHtml('<h2 id="a" onclick="x()">T</h2><script>alert(1)</script><iframe src="//e"></iframe><p onmouseover="x()">p</p>');
		expect(out).not.toMatch(/script|iframe|onclick|onmouseover/);
		expect(out).toContain('<h2 id="a">T</h2>');
	});

	it('the product policy is unchanged (no ids)', () => {
		expect(toSanitizedHtml('<h2 id="a">T</h2>', 'product').html).not.toMatch(/\bid=/);
	});
});

describe('TOC is checked against the final body', () => {
	it('every toc id exists as an id in the final sanitised body, in document order', () => {
		const { body, toc } = buildBlogBody('<h2>One</h2><p>a</p><h2>Two</h2><h2>Three</h2><h3>sub</h3>');
		expect(toc.map((t) => t.id)).toEqual(['one', 'two', 'three']);
		for (const t of toc) expect(body.html).toContain(`id="${t.id}"`);
	});

	it('an entry whose id the sanitiser dropped (location) is omitted, the rest keep order', () => {
		const { body, toc } = buildBlogBody('<h2>One</h2><h2>Location</h2><h2>Three</h2>');
		expect(toc.map((t) => t.id)).toEqual(['one', 'three']);
		for (const t of toc) expect(body.html).toContain(`id="${t.id}"`);
		expect(body.html).not.toContain('id="location"');
		expect(body.html).toContain('Location');
	});

	it('an authored id on a paragraph never makes a TOC entry; an authored h3 id survives but is not in the TOC', () => {
		const { body, toc } = buildBlogBody('<h2>One</h2><p id="sneaky">x</p><h3 id="own-anchor">s</h3>');
		expect(toc.map((t) => t.id)).toEqual(['one']);
		expect(body.html).not.toContain('sneaky');
		expect(body.html).toContain('id="own-anchor"');
	});

	it('tocFromSanitized hands a view plain text (entities decoded)', () => {
		expect(buildBlogBody('<h2>Fit &amp; Care</h2>').toc).toEqual([{ id: 'fit-amp-care', text: 'Fit & Care' }]);
	});

	it('tocFromSanitized ignores ids on other elements and duplicates', () => {
		expect(tocFromSanitized('<h2 id="a">A</h2><p id="b">B</p><h2 id="a">A again</h2><h2>no id</h2>')).toEqual([{ id: 'a', text: 'A' }]);
	});

	it('the final body is a SanitizedHtml', () => {
		expect(buildBlogBody('<h2>x</h2>').body.kind).toBe('sanitized-html');
	});
});

describe('rankRelatedPosts', () => {
	const p = (slug: string, tags: string[], publishedAt: string | null) => ({ slug, tags, publishedAt });
	const pool = [
		p('current', ['a', 'b'], '2026-05-01'),
		p('old-two-shared', ['a', 'b'], '2026-01-01'),
		p('new-one-shared', ['a'], '2026-04-01'),
		p('newer-one-shared', ['B'], '2026-04-15'),
		p('no-tags-newest', [], '2026-06-01'),
		p('zz-tie', ['a'], '2026-04-01'),
		p('aa-tie', ['a'], '2026-04-01'),
	];

	it('orders by shared tags, then recency, then slug; never includes the current post', () => {
		const out = rankRelatedPosts({ slug: 'current', tags: ['a', 'b'] }, pool, 10).map((x) => x.slug);
		expect(out).toEqual(['old-two-shared', 'newer-one-shared', 'aa-tie', 'new-one-shared', 'zz-tie', 'no-tags-newest']);
	});

	it('honours the limit and the 40-post pool', () => {
		expect(rankRelatedPosts({ slug: 'current', tags: ['a'] }, pool, 2)).toHaveLength(2);
		const big = Array.from({ length: 60 }, (_, i) => p(`p${String(i).padStart(2, '0')}`, i >= 45 ? ['a'] : [], '2026-01-01'));
		const out = rankRelatedPosts({ slug: 'x', tags: ['a'] }, big, 5).map((x) => x.slug);
		expect(out.every((s) => Number(s.slice(1)) < 40)).toBe(true);
	});

	it('a post without a date sorts as oldest', () => {
		const out = rankRelatedPosts({ slug: 'c', tags: [] }, [p('undated', [], null), p('dated', [], '2026-01-01')], 2).map((x) => x.slug);
		expect(out).toEqual(['dated', 'undated']);
	});
});
