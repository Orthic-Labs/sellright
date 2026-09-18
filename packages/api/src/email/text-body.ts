import sanitizeHtml from 'sanitize-html';

export const textBody = (html: string): string => sanitizeHtml(html, {
  allowedTags: [],
  allowedAttributes: {},
});
