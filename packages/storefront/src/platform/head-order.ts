// F2: the render-blocking stylesheet first in <head>; Qwik's speculative-preload hints out of its way.
//
// Qwik 2.0.0-rc.3 writes, the moment <head> opens and before any of the app's head JSX (core.mjs: emitQwikLoaderAtTopIfNeeded,
// then server.mjs preloaderPre): a modulepreload + async <script> for qwikloader, a modulepreload for the preloader bundle, a
// <link rel=preload as=fetch> for bundle-graph.json, the after-load preloader bootstrap <script>, and a modulepreload for core.
// The manifest's stylesheet injection (global.css -> /build/style-*.css) is written LAST, after the app's head. On a slow link the
// only render-blocking resource was discovered and queued behind three JS bundles, the graph JSON and the font preloads (Lighthouse,
// dd /shop/ on slow 4G: FCP 4.6 s, LCP render delay 5-10 s). No render option moves them: `preloader` (PreloaderOptions) has only
// ssrPreloads (already 0) and maxIdlePreloads, and `false` also drops the after-load preloading the pruned graph (preload-graph.ts)
// is built for.
//
// So the finished <head> markup is reordered on its way to the response, and ONLY in a way the client cannot observe: Qwik's resume
// maps vnode data onto elements by their position among the `:`-marked elements of the head (processVNodeData counts them), and the
// head's vnode data records runs of elements between virtual nodes. Every element therefore stays in its run and the number of
// marked elements before any position is unchanged:
//   - The stylesheet link(s) at the very end of the head trade places with as many of Qwik's top links (bundle-graph first, then
//     the preloader's): same tag (<link>), no vnode data of their own, so the run lengths and the tag at that index are as before.
//   - Inside the top run (Qwik's links + the head's leading <meta charset> and <meta name=viewport>, all plain void elements) the
//     order becomes: charset, viewport, stylesheet(s), core modulepreload, qwikloader modulepreload + its async <script>, then the
//     rest. The unmarked <script>s are not counted and keep their place relative to the link they follow.
//   - The preloader bundle's modulepreload and the bundle-graph preload become rel=prefetch (idle, lowest priority). The
//     preloader's own bootstrap script already fetches both after window load; they no longer compete with the CSS and the LCP.
// Anything that does not have exactly the expected shape is passed through untouched (a different Qwik version, a dev render).

/** A Qwik-written tag at the top of <head>: a void <link>, or a <script>...</script> (not a `:`-marked element). */
interface TopTag {
	html: string;
	kind: 'link' | 'script';
}

const TOP_TAG = /<link\b[^>]*>|<script\b[^>]*>[\s\S]*?<\/script>/y;
const ATTR = (name: string) => new RegExp(`\\s${name}="([^"]*)"`);
const attr = (tag: string, name: string) => ATTR(name).exec(tag)?.[1];
const STYLESHEET_TAIL = /(?:<link\b[^>]*\srel="stylesheet"[^>]*>)+$/;
const STYLESHEET = /<link\b[^>]*>/g;

/** Reorder one complete `<head ...>...</head>` string (see above). Returns the input unchanged when its shape is not the expected one. */
export function reorderHead(head: string): string {
	const open = /^<head\b[^>]*>/.exec(head);
	if (!open || !head.endsWith('</head>')) return head;
	const inner = head.slice(open[0].length, -'</head>'.length);

	// Qwik's top block: links and scripts only, up to the head's first <meta>.
	const top: TopTag[] = [];
	let at = 0;
	for (;;) {
		TOP_TAG.lastIndex = at;
		const m = TOP_TAG.exec(inner);
		if (!m) break;
		top.push({ html: m[0], kind: m[0].startsWith('<link') ? 'link' : 'script' });
		at = TOP_TAG.lastIndex;
	}
	// The head JSX opens with <meta charSet> (and, if next, the viewport meta): the elements the stylesheet must follow.
	const lead = /^<meta\b[^>]*\scharSet="[^"]*"[^>]*>(?:<meta\b[^>]*\sname="viewport"[^>]*>)?/i.exec(inner.slice(at));
	if (!lead) return head;
	const middleStart = at + lead[0].length;

	const tail = STYLESHEET_TAIL.exec(inner);
	if (!tail || tail.index < middleStart) return head;
	const sheets = tail[0].match(STYLESHEET) ?? [];

	const links = top.filter((t) => t.kind === 'link');
	const scripts = top.filter((t) => t.kind === 'script');
	const qlScript = scripts.find((s) => attr(s.html, 'src'));
	const qlSrc = qlScript && attr(qlScript.html, 'src');
	const ql = links.find((l) => attr(l.html, 'rel') === 'modulepreload' && attr(l.html, 'href') === qlSrc);
	const graph = links.find((l) => attr(l.html, 'rel') === 'preload' && attr(l.html, 'as') === 'fetch');
	const boot = scripts.find((s) => s !== qlScript);
	const preloader = links.find((l) => l !== ql && attr(l.html, 'rel') === 'modulepreload' && !!boot && boot.html.includes(`import("${attr(l.html, 'href')}")`));
	const core = links.find((l) => l !== ql && l !== preloader && attr(l.html, 'rel') === 'modulepreload');
	// Every top tag must be one of the known ones, else this is not the shape this was written for.
	const known = [ql, qlScript, preloader, graph, boot, core].filter(Boolean);
	if (known.length !== top.length || !core) return head;

	// The links that go to the stylesheets' place at the end (bundle-graph first, then the preloader's): one per stylesheet.
	const displaced = [graph, preloader].filter((t): t is TopTag => !!t).slice(0, sheets.length);
	if (displaced.length !== sheets.length) return head;

	const prefetch = (t: TopTag) => t.html.replace(/\srel="(?:modulepreload|preload)"/, ' rel="prefetch"');
	const out: string[] = [lead[0], ...sheets, core.html];
	if (ql) out.push(ql.html);
	if (qlScript) out.push(qlScript.html);
	if (preloader && !displaced.includes(preloader)) out.push(prefetch(preloader));
	if (boot) out.push(boot.html);
	if (graph && !displaced.includes(graph)) out.push(prefetch(graph));
	const middle = inner.slice(middleStart, tail.index);
	return `${open[0]}${out.join('')}${middle}${displaced.map(prefetch).join('')}</head>`;
}

/** The writer Qwik's renderToStream writes to (StreamWriter in @qwik.dev/core). */
export interface HeadStreamWriter {
	write(chunk: string): void | Promise<void>;
}

/** Bytes buffered while waiting for `</head>`; past this the markup passes through unchanged. */
const MAX_HEAD_BYTES = 256 * 1024;

/**
 * Wraps the response writer: buffers the document up to `</head>`, writes it reordered by `reorderHead`, then passes every later
 * chunk straight through. `flush()` writes anything still buffered (a render that never closed a head) unchanged.
 */
export function headOrderWriter(stream: HeadStreamWriter): HeadStreamWriter & { flush(): void | Promise<void> } {
	let buffer = '';
	let done = false;
	const release = (text: string) => {
		done = true;
		buffer = '';
		return text ? stream.write(text) : undefined;
	};
	return {
		write(chunk: string) {
			if (done) return stream.write(chunk);
			buffer += chunk;
			const end = buffer.indexOf('</head>');
			if (end === -1) return buffer.length > MAX_HEAD_BYTES ? release(buffer) : undefined;
			const close = end + '</head>'.length;
			const start = buffer.search(/<head\b/);
			if (start === -1 || start > end) return release(buffer);
			return release(buffer.slice(0, start) + reorderHead(buffer.slice(start, close)) + buffer.slice(close));
		},
		flush() {
			return done ? undefined : release(buffer);
		},
	};
}
