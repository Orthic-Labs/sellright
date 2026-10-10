/**
 * Shared email shell (plan 3.8). Every template wraps its body here; the store's
 * theme tokens (theme.ts) supply font, colours, logo and footer. With no theme on
 * the context the engine defaults apply and the output is unchanged.
 */
import { textBody as stripTags } from './text-body.js';
import { DEFAULT_EMAIL_THEME, type EmailTheme, type EmailThemeColors } from './theme.js';

export interface StoreCtx {
  name: string;
  currency: string;
  storefrontUrl: string;
  fromEmail: string;
  /** Resolved per store via resolveEmailTheme(store.config). Omitted = engine defaults. */
  theme?: EmailTheme;
}

export const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export const themeOf = (store: StoreCtx): EmailTheme => store.theme ?? DEFAULT_EMAIL_THEME;
export const colorsOf = (store: StoreCtx): EmailThemeColors => themeOf(store).colors;

export const renderEmailShell = (store: StoreCtx, title: string, body: string) => {
  const t = themeOf(store);
  const footerLabel = t.footerText ?? store.name;
  const logo = t.logoUrl
    ? `<img src="${escape(t.logoUrl)}" alt="${escape(store.name)}" style="display:block;border:0;max-width:180px;height:auto;margin:0 0 16px">\n    `
    : '';
  return {
    // Strip CR/LF from the subject — titles interpolate caller data (e.g. the
    // inviter's email in staffInvite); a newline would otherwise allow SMTP
    // header injection. (HTML-escaping is wrong for a subject; it's not HTML.)
    subject: `[${store.name}] ${title}`.replace(/[\r\n]+/g, ' '),
    html: `<!doctype html><html><body style="font-family:${t.fontFamily};max-width:560px;margin:0 auto;padding:24px;color:${t.colors.text}">
    ${logo}<h2 style="margin:0 0 16px">${escape(title)}</h2>
    ${body}
    <hr style="border:none;border-top:1px solid ${t.colors.rule};margin:24px 0">
    <p style="color:${t.colors.footer};font-size:12px">${escape(footerLabel)}</p>
  </body></html>`,
    text: `${title}\n\n${stripTags(body)}\n\n— ${footerLabel}`,
  };
};
