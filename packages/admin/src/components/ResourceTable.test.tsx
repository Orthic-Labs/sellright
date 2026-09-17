// @vitest-environment jsdom
// SR-14 — the orders table was unreadable at 390px: `table-fixed w-full`
// crushed percentage columns into fragments. The fix wraps the table in a
// contained horizontal scroller (`.overflow-x-auto`, same pattern as
// ProductDetail) and gives it a `min-width` so columns keep readable widths.
// jsdom can't measure layout, so these assertions pin the STRUCTURE that
// produces the behaviour; the 390px visual check is the QA browser sweep.
import { describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { ReactNode } from 'react';
import { ResourceTable, Badge, type Column } from './ui.js';

interface Row { code: string; email: string; state: string; total: string }

const COLUMNS: Column<Row>[] = [
  { key: 'code', header: 'Order', width: '20%', render: (r) => <span className="font-medium">{r.code}</span> },
  { key: 'customer', header: 'Customer', render: (r) => <span className="text-gray-600 truncate block">{r.email}</span> },
  { key: 'status', header: 'Payment', width: '16%', render: (r) => <Badge value={r.state} /> },
  { key: 'total', header: 'Total', align: 'right', width: '15%', render: (r) => <span className="font-medium tnum">{r.total}</span> },
];

const ROWS: Row[] = [
  { code: 'ORD-01000-Q1-VERY-LONG-CODE', email: 'verylongemailaddress.test+tag@some-corporate-domain.example.org', state: 'Paid', total: '$12.00' },
  { code: 'ORD-01001-Q2', email: 'a.customer+filter@anotherdomain.co', state: 'PendingPayment', total: '€84.55' },
];

function mount(node: ReactNode): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(node); });
  return { container, root };
}

function unmount(container: HTMLDivElement, root: Root) {
  act(() => { root.unmount(); });
  container.remove();
}

describe('ResourceTable — mobile containment (SR-14)', () => {
  it('wraps the table in a contained horizontal scroller with a min-width floor', () => {
    const { container, root } = mount(
      <ResourceTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.code} />,
    );
    try {
      const scroller = container.querySelector('.overflow-x-auto');
      const table = scroller?.querySelector('table');
      expect(scroller, 'table must sit inside an overflow-x-auto wrapper').not.toBeNull();
      expect(table?.className).toContain('table-fixed');
      expect(table?.style.minWidth).toBe('36rem'); // default floor
    } finally {
      unmount(container, root);
    }
  });

  it('honours a per-page minWidth override (orders uses 40rem)', () => {
    const { container, root } = mount(
      <ResourceTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.code} minWidth="40rem" />,
    );
    try {
      expect(container.querySelector('table')?.style.minWidth).toBe('40rem');
    } finally {
      unmount(container, root);
    }
  });

  it('renders long codes, emails, status badges and totals as cell content', () => {
    const { container, root } = mount(
      <ResourceTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.code} />,
    );
    try {
      const text = container.textContent ?? '';
      expect(text.length).toBeGreaterThan(0); // nonblank rendered content
      expect(text).toContain('ORD-01000-Q1-VERY-LONG-CODE');
      expect(text).toContain('verylongemailaddress.test+tag@some-corporate-domain.example.org');
      expect(text).toContain('Paid');
      expect(text).toContain('Pending'); // PendingPayment → LABELS short form
      expect(text).toContain('€84.55');
    } finally {
      unmount(container, root);
    }
  });

  it('keeps the selection checkbox column inside the same scrollable table', () => {
    const { container, root } = mount(
      <ResourceTable
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(r) => r.code}
        selection={{
          selectedKeys: new Set([ROWS[0]!.code]),
          onToggle: () => {},
          onToggleAllVisible: () => {},
        }}
      />,
    );
    try {
      const scroller = container.querySelector('.overflow-x-auto');
      expect(scroller?.querySelectorAll('input[type="checkbox"]').length).toBe(ROWS.length + 1);
    } finally {
      unmount(container, root);
    }
  });

  it('loading skeleton uses the same scroller + min-width', () => {
    const { container, root } = mount(
      <ResourceTable columns={COLUMNS} rows={undefined} rowKey={(r) => r.code} loading />,
    );
    try {
      const table = container.querySelector('.overflow-x-auto > table');
      expect(table).not.toBeNull();
      expect((table as HTMLTableElement).style.minWidth).toBe('36rem');
    } finally {
      unmount(container, root);
    }
  });
});
