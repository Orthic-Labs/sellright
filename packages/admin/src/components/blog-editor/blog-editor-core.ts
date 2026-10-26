import { Editor, Extension, Mark, Node, type Extensions } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';

/**
 * Editor schema mirrors the API allowlist in packages/api/src/lib/sanitize-html.ts,
 * which is the Vendure blog allowlist (damned/admin/src/plugins/blog/services/
 * blog-post.service.ts): text/inline/list/quote/code/link/img nodes are real
 * ProseMirror nodes; everything the visual schema cannot express (div, section,
 * article, table, figure, inline svg ... with class/style/id/data-*) is kept
 * verbatim by the Raw HTML block below, so a rich infographic post survives an
 * open -> edit -> save round trip.
 */

/** Block-level elements captured verbatim as a Raw HTML block when an existing post is opened. */
const RAW_BLOCK_TAGS = ['div', 'section', 'article', 'aside', 'header', 'footer', 'table', 'figure', 'svg'];

/** The one element the HTML consists of (ignoring surrounding whitespace), or null when it is empty or several nodes. */
function singleElement(html: string): Element | null {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const nodes = [...tpl.content.childNodes].filter((n) => !(n.nodeType === 3 && !n.textContent?.trim()));
  return nodes.length === 1 && nodes[0]!.nodeType === 1 ? (nodes[0] as Element) : null;
}

/**
 * Vendure's Raw HTML block node (dashboard/TipTapEditor.tsx RawHtmlNode): an atom holding
 * arbitrary HTML that is written back out as-is. Difference: instead of a text placeholder
 * patched by regex, the node serialises its HTML directly (no wrapper when it is one element),
 * and existing div/table/svg/... blocks are captured into it on load so they are not flattened.
 */
export const RawHtml = Node.create({
  name: 'rawHtml',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes() {
    return { html: { default: '', rendered: false } };
  },
  parseHTML() {
    return [
      { tag: 'div[data-raw-html]', priority: 1000, getAttrs: (el) => ({ html: (el as HTMLElement).innerHTML }) },
      ...RAW_BLOCK_TAGS.map((tag) => ({ tag, priority: 60, getAttrs: (el: HTMLElement | string) => ({ html: (el as HTMLElement).outerHTML }) })),
    ];
  },
  renderHTML({ node }) {
    const html = String(node.attrs.html ?? '');
    const single = singleElement(html);
    if (single) return single;
    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-raw-html', '');
    wrapper.innerHTML = html;
    return wrapper;
  },
  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement('div');
      dom.className = 'raw-html-block';
      const label = document.createElement('div');
      label.className = 'raw-html-label';
      label.textContent = 'Raw HTML Block';
      const textarea = document.createElement('textarea');
      textarea.className = 'raw-html-source';
      textarea.value = String(node.attrs.html ?? '');
      textarea.spellcheck = false;
      textarea.setAttribute('aria-label', 'Raw HTML block');
      textarea.placeholder = 'Paste raw HTML here (div, table, svg, etc.)';
      textarea.addEventListener('input', () => {
        const pos = getPos();
        if (typeof pos !== 'number') return;
        editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { html: textarea.value }));
      });
      dom.append(label, textarea);
      return {
        dom,
        update: (updated) => {
          if (updated.type.name !== 'rawHtml') return false;
          if (textarea.value !== updated.attrs.html) textarea.value = String(updated.attrs.html ?? '');
          return true;
        },
        stopEvent: (event) => event.target === textarea,
        ignoreMutation: () => true,
      };
    };
  },
});

/** <mark>, <sub>, <sup>: in the API allowlist, not in StarterKit. */
const Highlight = Mark.create({ name: 'mark', parseHTML: () => [{ tag: 'mark' }], renderHTML: ({ HTMLAttributes }) => ['mark', HTMLAttributes, 0] });
const Subscript = Mark.create({ name: 'subscript', excludes: 'superscript', parseHTML: () => [{ tag: 'sub' }], renderHTML: ({ HTMLAttributes }) => ['sub', HTMLAttributes, 0] });
const Superscript = Mark.create({ name: 'superscript', excludes: 'subscript', parseHTML: () => [{ tag: 'sup' }], renderHTML: ({ HTMLAttributes }) => ['sup', HTMLAttributes, 0] });

const passthrough = (name: string) => ({
  default: null as string | null,
  parseHTML: (el: HTMLElement) => el.getAttribute(name),
  renderHTML: (attrs: Record<string, unknown>) => (attrs[name] ? { [name]: attrs[name] as string } : {}),
});

/** class/style on inline <span> (kept as a mark only when it carries one of them). */
const StyledSpan = Mark.create({
  name: 'styledSpan',
  parseHTML: () => [{ tag: 'span', getAttrs: (el) => ((el as HTMLElement).getAttribute('class') || (el as HTMLElement).getAttribute('style') || (el as HTMLElement).id ? null : false) }],
  addAttributes: () => ({ class: passthrough('class'), style: passthrough('style'), id: passthrough('id') }),
  renderHTML: ({ HTMLAttributes }) => ['span', HTMLAttributes, 0],
});

/** The allowlist permits class/style/id on every tag: carry them on the text blocks so they are not dropped on open. */
const BlockAttributes = Extension.create({
  name: 'blockAttributes',
  addGlobalAttributes() {
    return [
      { types: ['paragraph', 'heading', 'blockquote', 'bulletList', 'orderedList', 'listItem', 'codeBlock', 'horizontalRule', 'image'], attributes: { class: passthrough('class'), style: passthrough('style'), id: passthrough('id') } },
      { types: ['image'], attributes: { loading: passthrough('loading') } },
    ];
  },
});

export function blogExtensions(): Extensions {
  return [
    StarterKit.configure({
      // h2-h4 are the allowlisted headings (Vendure UI offered h2/h3; h4 kept so existing posts are not downgraded).
      heading: { levels: [2, 3, 4] },
      link: {
        openOnClick: false,
        autolink: false,
        protocols: ['http', 'https', 'mailto'],
        // The API sanitiser opens every link in a new tab with this rel.
        HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
      },
    }),
    // allowBase64: the allowlist permits data: image URIs, so existing posts must not lose them on open.
    Image.configure({ inline: false, allowBase64: true }),
    Highlight, Subscript, Superscript, StyledSpan, BlockAttributes, RawHtml,
  ];
}

/**
 * Links: http(s), mailto, site-relative (/x) and #anchors; a bare domain gets https://
 * (Vendure addLink). Images: http(s) only. Everything else (javascript:, data:, //host) is refused.
 */
export function normalizeUrl(raw: string, isLink: boolean): string | null {
  const v = raw.trim();
  if (!v || v.startsWith('//')) return null;
  if (isLink && (v.startsWith('/') || v.startsWith('#'))) return v;
  try {
    const u = new URL(v);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.toString();
    if (isLink && u.protocol === 'mailto:') return v;
    return null;
  } catch { /* not absolute */ }
  if (isLink && !/^[a-z][a-z0-9+.-]*:/i.test(v) && /^[^\s/@:]+\.[^\s/@]+/.test(v)) {
    try { return new URL(`https://${v}`).toString(); } catch { return null; }
  }
  return null;
}

/** A document that is a single empty paragraph (Tiptap's empty state) - raw HTML blocks count as content. */
function isBlank(editor: Editor): boolean {
  const { doc } = editor.state;
  return doc.childCount === 1 && doc.firstChild!.type.name === 'paragraph' && doc.firstChild!.childCount === 0;
}

/**
 * Tiptap's empty document serialises as <p></p> (store '' instead) and its
 * trailing-node helper appends an empty <p></p> after a final block - drop it.
 * Empty Raw HTML blocks emit nothing.
 */
export function htmlOut(editor: Editor): string {
  if (isBlank(editor)) return '';
  return editor.getHTML().replace(/<div data-raw-html=""><\/div>/g, '').replace(/(?<=.)<p><\/p>$/, '');
}
