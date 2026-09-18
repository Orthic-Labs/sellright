import sanitizeHtml from 'sanitize-html';

export function textBody(html: string): string {
  let text = '';
  const links: string[] = [];
  sanitizeHtml(html, {
    allowedTags: [],
    allowedAttributes: {},
    onOpenTag(tag, attributes) {
      if (tag === 'a') links.push(attributes.href ?? '');
      if (tag === 'br') text += '\n';
    },
    textFilter(escaped) {
      text += escaped;
      return '';
    },
    onCloseTag(tag) {
      if (tag === 'a') {
        const href = links.pop();
        if (href) text += ` (${href.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))})`;
      }
      if (tag === 'p') text += '\n\n';
    },
  });
  return text.replace(/\n{3,}/g, '\n\n').trim();
}
