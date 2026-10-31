import { describe, expect, it } from 'vitest';
import { deferredLoaderInjections, deferredLoaderScript } from './deferred-loader.server';

describe('#425 deferred Qwik loader', () => {
	it('adds the loader module once: after two frames, on first interaction, or after 1 s', () => {
		const s = deferredLoaderScript('/build/q-loader.js');
		expect(s).toContain('"/build/q-loader.js"');
		expect(s).toContain("s.type='module'");
		expect(s).toContain('requestAnimationFrame(function(){requestAnimationFrame(go)})');
		expect(s).toContain("'pointerdown','keydown','touchstart'");
		expect(s).toContain('setTimeout(go,1000)');
		expect(s).toContain('if(d)return;d=1');
		expect(() => new Function(s)).not.toThrow();
	});

	it('emits a modulepreload plus the bootstrap, carrying the nonce only when there is one', () => {
		const [link, script] = deferredLoaderInjections('/build/q-l.js', 'N1');
		expect(link).toEqual({ tag: 'link', location: 'head', attributes: { rel: 'modulepreload', href: '/build/q-l.js', nonce: 'N1' } });
		expect(script.attributes?.nonce).toBe('N1');
		expect(deferredLoaderInjections('/build/q-l.js', undefined)[1].attributes).not.toHaveProperty('nonce');
	});

	it('runs once even if every trigger fires', () => {
		const added: string[] = [];
		let raf = 0;
		const win = {
			requestAnimationFrame: (f: () => void) => { raf++; f(); },
			addEventListener: (_t: string, f: () => void) => f(),
			setTimeout: (f: () => void) => f(),
		};
		const doc = { createElement: () => ({}) as Record<string, string>, head: { appendChild: (e: Record<string, string>) => added.push(e.src) } };
		new Function('window', 'document', 'requestAnimationFrame', 'addEventListener', 'setTimeout', deferredLoaderScript('/build/q.js'))(win, doc, win.requestAnimationFrame, win.addEventListener, win.setTimeout);
		expect(added).toEqual(['/build/q.js']);
		expect(raf).toBeGreaterThan(0);
	});
});
