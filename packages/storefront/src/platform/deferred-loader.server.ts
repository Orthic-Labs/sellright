// #425: Qwik's loader starts after the first frame. On an edge-cached page the whole HTML arrives at once, the loader ran before
// the browser's first paint and its startup handler chain held that paint (live dd home A/B from a PC, Lantern: Qwik scripts blocked
// 85-89 vs 72 as live; fonts and Early Hints made no difference). The framework's own loader tag is turned off
// (`qwikLoader: 'never'`) and this injection replaces it: a modulepreload keeps the download early, and a tiny inline script adds the
// loader module after two animation frames (the first frame is painted), on the first interaction if that comes sooner, or after
// 1 s when frames never fire (a background tab). The parse-time live reads (early-reads.ts) do not depend on the loader, so stock and
// prices still start at document parse.
import type { GlobalInjections } from '@qwik.dev/core/optimizer';

/** The bootstrap that adds `<script type="module" src>` once. Exported for tests. */
export function deferredLoaderScript(src: string): string {
	return `(()=>{var d=0;function go(){if(d)return;d=1;var s=document.createElement('script');s.type='module';s.src=${JSON.stringify(src)};document.head.appendChild(s)}` +
		`['pointerdown','keydown','touchstart'].forEach(function(t){addEventListener(t,go,{capture:true,passive:true,once:true})});` +
		`'requestAnimationFrame'in window?requestAnimationFrame(function(){requestAnimationFrame(go)}):go();setTimeout(go,1000)})()`;
}

/** The head injections for one render: the loader's modulepreload and the deferred bootstrap (with this render's nonce, if any). */
export function deferredLoaderInjections(src: string, nonce: string | undefined): GlobalInjections[] {
	const n: Record<string, string> = nonce ? { nonce } : {};
	return [
		{ tag: 'link', location: 'head', attributes: { rel: 'modulepreload', href: src, ...n } },
		{ tag: 'script', location: 'head', attributes: { ...n, dangerouslySetInnerHTML: deferredLoaderScript(src) } },
	];
}
