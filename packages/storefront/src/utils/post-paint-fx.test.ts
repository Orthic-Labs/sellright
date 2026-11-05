// F1: first-paint stall triggers stay off the first frame (decoding=sync, header backdrop-filter, scroll-timeline animations).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { enablePostPaintEffects, POST_PAINT_FX_CLASS } from './post-paint-fx';
import { HEADER_STYLES } from '~/components/header/header-styles';

const SRC = join(process.cwd(), 'src');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const walk = (dir: string): string[] =>
	readdirSync(dir).flatMap((n) => {
		const p = join(dir, n);
		return statSync(p).isDirectory() ? walk(p) : [p];
	});

afterEach(() => {
	document.documentElement.classList.remove(POST_PAINT_FX_CLASS);
	vi.restoreAllMocks();
});

describe('enablePostPaintEffects', () => {
	it('adds the class only after two animation frames', () => {
		const frames: FrameRequestCallback[] = [];
		vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => (frames.push(cb), frames.length));
		enablePostPaintEffects();
		expect(document.documentElement.classList.contains(POST_PAINT_FX_CLASS)).toBe(false);
		frames.shift()!(0);
		expect(document.documentElement.classList.contains(POST_PAINT_FX_CLASS)).toBe(false);
		frames.shift()!(16);
		expect(document.documentElement.classList.contains(POST_PAINT_FX_CLASS)).toBe(true);
	});
	it('is a no-op once set', () => {
		document.documentElement.classList.add(POST_PAINT_FX_CLASS);
		const raf = vi.spyOn(window, 'requestAnimationFrame');
		enablePostPaintEffects();
		expect(raf).not.toHaveBeenCalled();
	});
});

describe('first-frame stall triggers (F1)', () => {
	it('the layout enables post-paint effects from its qidle handler', () => {
		const idle = read('routes/layout.tsx').match(/useOnDocument\('qidle'[\s\S]*?\n\t\}\)\);/)?.[0] ?? '';
		expect(idle).toContain('enablePostPaintEffects()');
	});
	it('no storefront source asks for synchronous image decoding', () => {
		const offenders = walk(SRC)
			.filter((f) => /\.(tsx?|css)$/.test(f) && !f.endsWith('.test.ts') && !f.endsWith('.test.tsx'))
			.filter((f) => /decoding=["']sync["']|decoding:\s*["']sync["']|\?\s*'sync'/.test(readFileSync(f, 'utf8')));
		expect(offenders).toEqual([]);
	});
	it('header backdrop-filter and scroll-timeline only apply under html.sr-fx', () => {
		const css = HEADER_STYLES.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@keyframes[\s\S]*?\n {2}\}\n/g, '');
		const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, body]) => ({ sel: sel!.trim(), body: body! }));
		for (const r of rules.filter((r) => /backdrop-filter|animation-timeline/.test(r.body))) {
			if (r.sel.startsWith('.mobile-overlay')) continue; // shown only after a tap, never on the first frame
			expect(r.sel, r.sel).toMatch(/^\.sr-fx /);
		}
	});
});
