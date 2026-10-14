import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures';

/**
 * A18 — computed-style probe. Asserts getComputedStyle values of the global brand tokens against LITERAL values recorded from
 * the css as it was BEFORE the token move (src/global.css @theme + :root, plus the literals that component CSS inlined), so
 * the same spec must pass on the pre-A18 build and on the tokenised build: that equality is the "zero visual change" proof for
 * colours, fonts, page background, scrollbar track and the iOS dark vars. Colours are compared as resolved rgb() (the browser
 * resolves any hex case or minified form), font stacks quote/space-insensitively.
 *
 * Tailwind v4 only emits a registered @theme variable when something uses it, so four registry colours may legitimately be
 * absent from the document; for those the value must be EITHER empty OR the literal, and the empty set is recorded as an
 * annotation: compare that annotation between the pre- and post-change run, it must be identical.
 *
 * Skipped (= missing coverage, reported as such) unless E2E_TOKEN_PROBE=1. NEVER RUN when this file was written.
 */
test.skip(process.env.E2E_TOKEN_PROBE !== '1', 'needs E2E_TOKEN_PROBE=1: did not run, missing coverage');

const PAGE = '/terms/'; // static copy page: full layout chrome, no catalog data needed

const rgb = (r: number, g: number, b: number) => `rgb(${r}, ${g}, ${b})`;

// name -> resolved colour of the literal in the css before A18
const ALWAYS_COLOURS: Record<string, string> = {
	'--color-ink': rgb(24, 24, 27), // #18181b
	'--color-ink-soft': rgb(82, 82, 91), // #52525b
	'--color-ink-muted': rgb(161, 161, 170), // #a1a1aa
	'--color-ink-contrast': rgb(250, 250, 250), // #fafafa
	'--color-parchment': rgb(244, 244, 245), // #f4f4f5
	'--color-card-border': rgb(228, 228, 231), // #e4e4e7
	'--color-accent': rgb(37, 99, 235), // #2563eb
	'--color-accent-hover': rgb(29, 78, 216), // #1d4ed8
	// iOS dark :root vars (stay dark, stay in global.css)
	'--color-bg': rgb(15, 15, 15), // #0F0F0F
	'--color-surface': rgb(26, 26, 26), // #1A1A1A
	'--color-border': rgb(42, 42, 42), // #2A2A2A
	'--color-text': rgb(232, 232, 232), // #E8E8E8
	'--color-text-muted': rgb(136, 136, 136), // #888888
};
const OPTIONAL_COLOURS: Record<string, string> = {
	'--color-ink-hover': rgb(39, 39, 42), // #27272a
	'--color-parchment-hover': rgb(228, 228, 231), // #e4e4e7
	'--color-image-bg': rgb(24, 24, 27), // #18181b
	'--color-tint': rgb(228, 228, 231), // #e4e4e7
};
// not colours: raw token text
const TRIPLETS: Record<string, string> = {
	'--color-accent-rgb': '37,99,235',
	'--color-tooltip-rgb': '17,17,16', // was the literal rgba(17,17,16,0.88) in product-styles.ts
	'--color-on-dark-rgb': '247,242,234', // was the literal rgba(247,242,234,x) in OrderProcessingModal.tsx
};
const SANS = 'inter,system-ui,-apple-system,sans-serif';
const FONTS: Record<string, string> = {
	'--font-display': SANS,
	'--font-heading': SANS,
	'--font-body': SANS,
	'--font-mono': 'ui-monospace,sfmono-regular,ibmplexmono,monospace',
};

const norm = (s: string) => s.toLowerCase().replace(/["'\s]/g, '');

/** Runs in the page: reads tokens and consumers, returns plain data. */
async function probe(page: import('@playwright/test').Page) {
	return page.evaluate(
		({ colourNames, tripletNames, fontNames }) => {
			const root = document.documentElement;
			const cs = getComputedStyle(root);
			const resolve = (value: string) => {
				const el = document.createElement('span');
				el.style.color = value;
				document.body.appendChild(el);
				const out = getComputedStyle(el).color;
				el.remove();
				return out;
			};
			const tokenText = (n: string) => cs.getPropertyValue(n).trim();
			const colours: Record<string, string> = {};
			for (const n of colourNames) {
				const v = tokenText(n);
				colours[n] = v ? resolve(v) : '';
			}
			const triplets: Record<string, string> = {};
			for (const n of tripletNames) triplets[n] = tokenText(n);
			const fonts: Record<string, string> = {};
			for (const n of fontNames) fonts[n] = tokenText(n);

			// consumers
			const consumer = (css: string, prop: string) => {
				const el = document.createElement('div');
				el.setAttribute('style', css);
				document.body.appendChild(el);
				const out = getComputedStyle(el).getPropertyValue(prop);
				el.remove();
				return out;
			};
			const btn = document.createElement('button');
			btn.className = 'btn-primary';
			document.body.appendChild(btn);
			const btnBg = getComputedStyle(btn).backgroundColor;
			btn.remove();

			const main = document.querySelector('#main-content');
			const mainBg = main ? getComputedStyle(main).backgroundColor : '';
			const wrapBg = main?.parentElement ? getComputedStyle(main.parentElement).backgroundColor : '';
			const h1 = document.querySelector('h1');

			// scrollbar track: the ::-webkit-scrollbar-track rule's background, resolved
			let trackRule = '';
			for (const sheet of Array.from(document.styleSheets)) {
				let rules: CSSRuleList;
				try { rules = sheet.cssRules; } catch { continue; }
				for (const rule of Array.from(rules)) {
					const r = rule as CSSStyleRule;
					if (r.selectorText && r.selectorText.includes('::-webkit-scrollbar-track')) trackRule = r.style.getPropertyValue('background') || r.style.getPropertyValue('background-color');
				}
			}

			return {
				colours,
				triplets,
				fonts,
				consumers: {
					accentBtnBg: btnBg,
					inkColour: resolve(consumer('color:var(--color-ink)', 'color')),
					accentBorder: resolve(consumer('border-color:var(--color-accent)', 'border-top-color')),
					monoFamily: consumer('font-family:var(--font-mono)', 'font-family'),
					displayFamily: h1 ? getComputedStyle(h1).fontFamily : '',
					bodyFamily: getComputedStyle(document.body).fontFamily,
				},
				page: {
					htmlBg: cs.backgroundColor,
					mainBg,
					wrapBg,
					scrollbarColour: cs.scrollbarColor,
					trackRule: trackRule ? resolve(trackRule) : '',
				},
			};
		},
		{ colourNames: [...Object.keys(ALWAYS_COLOURS), ...Object.keys(OPTIONAL_COLOURS)], tripletNames: Object.keys(TRIPLETS), fontNames: Object.keys(FONTS) },
	);
}

test.describe('global token computed styles (A18)', () => {
	test('colours, triplets and font stacks equal the pre-A18 literals', async ({ page }) => {
		await page.goto(PAGE);
		const got = await probe(page);

		for (const [name, expected] of Object.entries(ALWAYS_COLOURS)) expect(got.colours[name], name).toBe(expected);

		const empty: string[] = [];
		for (const [name, expected] of Object.entries(OPTIONAL_COLOURS)) {
			if (got.colours[name] === '') empty.push(name);
			else expect(got.colours[name], name).toBe(expected);
		}
		test.info().annotations.push({ type: 'unemitted-registry-tokens', description: empty.join(',') || '(none)' });

		for (const [name, expected] of Object.entries(TRIPLETS)) expect(got.triplets[name].replace(/\s/g, ''), name).toBe(expected);
		for (const [name, expected] of Object.entries(FONTS)) expect(norm(got.fonts[name]), name).toBe(expected);
	});

	test('one consumer per palette family resolves to the same colour and font', async ({ page }) => {
		await page.goto(PAGE);
		const { consumers } = await probe(page);
		expect(consumers.accentBtnBg).toBe(rgb(37, 99, 235)); // .btn-primary -> bg-[var(--color-accent)]
		expect(consumers.accentBorder).toBe(rgb(37, 99, 235));
		expect(consumers.inkColour).toBe(rgb(24, 24, 27));
		expect(norm(consumers.monoFamily)).toBe(FONTS['--font-mono']);
		expect(norm(consumers.bodyFamily)).toBe(SANS);
		expect(norm(consumers.displayFamily)).toBe(SANS);
	});

	test('page background, html background and scrollbar track keep their literal values', async ({ page }) => {
		await page.goto(PAGE);
		const { page: p } = await probe(page);
		expect(p.mainBg).toBe(rgb(244, 244, 245)); // layout.tsx: var(--color-page) -> --brand-color-page #f4f4f5 in the base
		expect(p.wrapBg).toBe(rgb(244, 244, 245));
		expect(p.htmlBg).toBe(rgb(26, 26, 26)); // head.tsx critical css: html { background-color: #1a1a1a }
		expect(p.trackRule).toBe(rgb(10, 10, 10)); // ::-webkit-scrollbar-track { background: #0A0A0A }
		expect(p.scrollbarColour).toBe(`${rgb(37, 99, 235)} ${rgb(10, 10, 10)}`); // scrollbar-color: var(--color-accent) #0A0A0A
	});

	test('source guard: iOS dark vars stay literal in global.css and are absent from brand/tokens.css', () => {
		const root = process.cwd(); // playwright runs from the package root (see playwright.config.ts)
		const globalCss = fs.readFileSync(path.join(root, 'src/global.css'), 'utf8');
		const tokensCss = fs.readFileSync(path.join(root, 'src/brand/tokens.css'), 'utf8');
		for (const line of ['--color-bg: #0F0F0F;', '--color-surface: #1A1A1A;', '--color-border: #2A2A2A;', '--color-text: #E8E8E8;', '--color-text-muted: #888888;']) {
			expect(globalCss).toContain(line);
			expect(tokensCss).not.toContain(line.split(':')[0] + ':');
		}
		expect(globalCss).toContain('background: #0A0A0A;');
		expect(globalCss).toContain('scrollbar-color: var(--color-accent) #0A0A0A;');
	});
});
