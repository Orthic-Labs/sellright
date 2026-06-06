/**
 * Invoice + packing-slip document builders. Pure — take an order snapshot and
 * produce a structured document (and printable HTML). No I/O, no money math
 * beyond formatting (the order already carries authoritative integer-cent totals).
 */
export type InvoiceOrder = {
  code: string;
  currency: string;
  createdAt: Date;
  placedAt: Date | null;
  subtotal: number;
  discountTotal: number;
  shippingTotal: number;
  taxTotal: number;
  grandTotal: number;
  shippingAddress: Record<string, unknown> | null;
  billingAddress: Record<string, unknown> | null;
};
export type InvoiceLine = { variantSku: string; variantName: string; quantity: number; unitPrice: number; lineTotal: number };
export type InvoiceStore = { name: string; slug: string };

const money = (cents: number, currency: string): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);

function addressLines(a: Record<string, unknown> | null): string[] {
  if (!a) return [];
  const g = (k: string) => (a[k] != null ? String(a[k]) : '');
  return [
    g('fullName'),
    g('line1'),
    g('line2'),
    [g('city'), g('province'), g('postalCode')].filter(Boolean).join(', '),
    g('country'),
    g('phone'),
  ].filter((l) => l.trim() !== '');
}

export type InvoiceDoc = {
  type: 'invoice';
  number: string;
  date: string;
  store: InvoiceStore;
  billTo: string[];
  shipTo: string[];
  currency: string;
  lines: Array<{ sku: string; name: string; quantity: number; unitPrice: string; lineTotal: string }>;
  totals: { subtotal: string; discount: string; shipping: string; tax: string; grand: string };
};

export function buildInvoice(order: InvoiceOrder, lines: InvoiceLine[], store: InvoiceStore): InvoiceDoc {
  const date = (order.placedAt ?? order.createdAt).toISOString().slice(0, 10);
  return {
    type: 'invoice',
    number: `INV-${order.code}`,
    date,
    store,
    billTo: addressLines(order.billingAddress ?? order.shippingAddress),
    shipTo: addressLines(order.shippingAddress),
    currency: order.currency,
    lines: lines.map((l) => ({
      sku: l.variantSku, name: l.variantName, quantity: l.quantity,
      unitPrice: money(l.unitPrice, order.currency), lineTotal: money(l.lineTotal, order.currency),
    })),
    totals: {
      subtotal: money(order.subtotal, order.currency),
      discount: money(order.discountTotal, order.currency),
      shipping: money(order.shippingTotal, order.currency),
      tax: money(order.taxTotal, order.currency),
      grand: money(order.grandTotal, order.currency),
    },
  };
}

export type PackingSlipDoc = {
  type: 'packing_slip';
  number: string;
  date: string;
  store: InvoiceStore;
  shipTo: string[];
  lines: Array<{ sku: string; name: string; quantity: number }>;
};

export function buildPackingSlip(order: InvoiceOrder, lines: InvoiceLine[], store: InvoiceStore): PackingSlipDoc {
  return {
    type: 'packing_slip',
    number: `PS-${order.code}`,
    date: (order.placedAt ?? order.createdAt).toISOString().slice(0, 10),
    store,
    shipTo: addressLines(order.shippingAddress),
    lines: lines.map((l) => ({ sku: l.variantSku, name: l.variantName, quantity: l.quantity })),
  };
}

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** Minimal printable HTML for an invoice (no external assets). */
export function renderInvoiceHtml(doc: InvoiceDoc): string {
  const rows = doc.lines
    .map((l) => `<tr><td>${esc(l.sku)}</td><td>${esc(l.name)}</td><td style="text-align:right">${l.quantity}</td><td style="text-align:right">${l.unitPrice}</td><td style="text-align:right">${l.lineTotal}</td></tr>`)
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(doc.number)}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;color:#111;max-width:760px;margin:2rem auto;padding:0 1rem}
h1{font-size:1.4rem;margin:0}table{width:100%;border-collapse:collapse;margin:1.5rem 0}
th,td{padding:.4rem .6rem;border-bottom:1px solid #ddd}th{text-align:left;font-size:.8rem;text-transform:uppercase;color:#666}
.addr{display:flex;gap:3rem;margin:1rem 0}.tot{margin-left:auto;width:260px}.tot td{border:none;padding:.2rem .6rem}
.grand{font-weight:700;border-top:2px solid #111}</style></head><body>
<div style="display:flex;justify-content:space-between;align-items:baseline">
<h1>${esc(doc.store.name)}</h1><div><strong>${esc(doc.number)}</strong><br>${doc.date}</div></div>
<div class="addr"><div><strong>Bill to</strong><br>${doc.billTo.map(esc).join('<br>') || '—'}</div>
<div><strong>Ship to</strong><br>${doc.shipTo.map(esc).join('<br>') || '—'}</div></div>
<table><thead><tr><th>SKU</th><th>Item</th><th style="text-align:right">Qty</th><th style="text-align:right">Unit</th><th style="text-align:right">Total</th></tr></thead><tbody>${rows}</tbody></table>
<table class="tot"><tr><td>Subtotal</td><td style="text-align:right">${doc.totals.subtotal}</td></tr>
<tr><td>Discount</td><td style="text-align:right">−${doc.totals.discount}</td></tr>
<tr><td>Shipping</td><td style="text-align:right">${doc.totals.shipping}</td></tr>
<tr><td>Tax</td><td style="text-align:right">${doc.totals.tax}</td></tr>
<tr class="grand"><td>Total</td><td style="text-align:right">${doc.totals.grand}</td></tr></table>
</body></html>`;
}
