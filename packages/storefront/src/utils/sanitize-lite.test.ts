import { describe, expect, it } from 'vitest';
import { cssText, htmlToText, sanitizeInlineScript } from './sanitize-lite';

describe('sanitize-lite', () => {
	it('htmlToText drops tags, script/style blocks and comments and decodes entities', () => {
		expect(htmlToText('<p>Tom &amp; <b>Jerry</b></p><script>alert(1)</script><style>a{}</style><!-- x -->&quot;hi&quot; &#39;x&#39;')).toBe('Tom & Jerry"hi" \'x\'');
	});
	it('htmlToText cannot be tricked into rebuilding a tag', () => {
		expect(htmlToText('<<b>script>alert(1)<</b>/script>')).not.toMatch(/<[a-z/]/i);
	});
	it('htmlToText handles empty and non-string input', () => {
		expect(htmlToText('')).toBe('');
		expect(htmlToText(undefined as unknown as string)).toBe('');
	});
	it('cssText keeps CSS and removes every `<`', () => {
		expect(cssText('a>b{c:d}@media(x){e{f:g}}')).toBe('a>b{c:d}@media(x){e{f:g}}');
		expect(cssText('a{}</style><script>1</script>')).toBe('a{}/style>script>1/script>');
		expect(cssText('a{}</style><script>1</script>')).not.toContain('<');
	});
	it('sanitizeInlineScript rejects dangerous patterns', () => {
		expect(sanitizeInlineScript('eval(1)')).toBe('');
		expect(sanitizeInlineScript('const a = 1;')).toBe('const a = 1;');
	});
});
