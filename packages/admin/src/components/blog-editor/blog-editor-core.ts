import { Editor, type Extensions } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';

/**
 * Editor schema mirrors the API allowlist in packages/api/src/lib/sanitize-html.ts
 * (h1-h6, p, a, ul/ol/li, strong, em, blockquote, code, pre, img, br, hr).
 * underline/strike are disabled because the API would strip <u>/<s> anyway.
 * Headings keep levels 1-6 so existing posts are not downgraded on open.
 */
export function blogExtensions(): Extensions {
  return [
    StarterKit.configure({
      underline: false,
      strike: false,
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      link: {
        openOnClick: false,
        autolink: false,
        protocols: ['http', 'https', 'mailto'],
        HTMLAttributes: { rel: 'noopener noreferrer', target: null },
      },
    }),
    Image.configure({ inline: false, allowBase64: false }),
  ];
}

/** http(s) only — matches the API's img scheme allowlist; mailto allowed for links. */
export function normalizeUrl(raw: string, allowMailto: boolean): string | null {
  const v = raw.trim();
  if (!v) return null;
  try {
    const u = new URL(v);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.toString();
    if (allowMailto && u.protocol === 'mailto:') return v;
  } catch { /* not absolute */ }
  return null;
}

/**
 * Tiptap's empty document serialises as <p></p> (store '' instead) and its
 * trailing-node helper appends an empty <p></p> after a final block — drop it.
 */
export function htmlOut(editor: Editor): string {
  return editor.isEmpty ? '' : editor.getHTML().replace(/(?<=.)<p><\/p>$/, '');
}
