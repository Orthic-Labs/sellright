import { api, apiText } from '../api';

export interface PackingSlipDoc {
  type: 'packing_slip';
  number: string;
  date: string;
  store: { name: string; slug: string };
  shipTo: string[];
  lines: { sku: string; name: string; quantity: number }[];
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Printable packing slip (no prices) built from GET /orders/{code}/packing-slip. No external assets, all text escaped. */
export function renderPackingSlipHtml(doc: PackingSlipDoc): string {
  const rows = doc.lines
    .map((l) => `<tr><td>${esc(l.sku)}</td><td>${esc(l.name)}</td><td style="text-align:right">${l.quantity}</td></tr>`)
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(doc.number)}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;color:#111;max-width:760px;margin:2rem auto;padding:0 1rem}
h1{font-size:1.4rem;margin:0}table{width:100%;border-collapse:collapse;margin:1.5rem 0}
th,td{padding:.4rem .6rem;border-bottom:1px solid #ddd}th{text-align:left;font-size:.8rem;text-transform:uppercase;color:#666}
.addr{margin:1rem 0}@media print{body{margin:0}}</style></head><body>
<div style="display:flex;justify-content:space-between;align-items:baseline"><h1>${esc(doc.store.name)}</h1><div><strong>${esc(doc.number)}</strong><br>${esc(doc.date)}</div></div>
<div class="addr"><strong>Ship to</strong><br>${doc.shipTo.map(esc).join('<br>') || '&mdash;'}</div>
<table><thead><tr><th>SKU</th><th>Item</th><th style="text-align:right">Qty</th></tr></thead><tbody>${rows}</tbody></table>
</body></html>`;
}

/**
 * Opens an order document in a new tab. The window is opened synchronously (inside the click) so popup blockers allow
 * it, then filled once the document arrives. It is fetched with the session cookie AND the active-store header, which
 * a plain link to /v1/admin/... could not send for admins on more than one store.
 */
export async function openOrderDocument(code: string, kind: 'invoice' | 'packing-slip'): Promise<void> {
  const w = window.open('', '_blank');
  if (!w) throw new Error('The browser blocked the new tab — allow pop-ups for this site and try again.');
  try {
    const enc = encodeURIComponent(code);
    const html = kind === 'invoice'
      ? await apiText(`/orders/${enc}/invoice?format=html`)
      : renderPackingSlipHtml(await api.get<PackingSlipDoc>(`/orders/${enc}/packing-slip`));
    w.document.open();
    w.document.write(html);
    w.document.close();
  } catch (e) {
    w.close();
    throw e;
  }
}
