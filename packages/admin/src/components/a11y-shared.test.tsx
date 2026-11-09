// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { Field } from './ui-forms.js';
import { Modal, ResourceTable } from './ui.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { document.body.innerHTML = ''; });

function mount(node: React.ReactNode) {
  const el = document.createElement('div'); document.body.appendChild(el);
  const root = createRoot(el); act(() => root.render(node));
  return { el, root };
}

describe('Field', () => {
  it('links label, error and required state to a single input', () => {
    const { el } = mount(<Field label="Email" required error="Bad address" hint="h"><input /></Field>);
    const input = el.querySelector('input')!;
    expect(el.querySelector('label')!.getAttribute('for')).toBe(input.id);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-required')).toBe('true');
    const err = el.querySelector('[role=alert]')!;
    expect(input.getAttribute('aria-describedby')).toContain(err.id);
  });
  it('links the hint when there is no error', () => {
    const { el } = mount(<Field label="Name" hint="Shown publicly"><input /></Field>);
    const input = el.querySelector('input')!;
    expect(document.getElementById(input.getAttribute('aria-describedby')!)!.textContent).toBe('Shown publicly');
    expect(input.hasAttribute('aria-invalid')).toBe(false);
  });
});

describe('Modal', () => {
  it('focuses inside, closes on Escape, restores focus, and ignores Escape while busy', () => {
    const opener = document.createElement('button'); document.body.appendChild(opener); opener.focus();
    const onClose = vi.fn();
    const el = document.createElement('div'); document.body.appendChild(el);
    const root = createRoot(el);
    act(() => root.render(<Modal open title="T" onClose={onClose}><input data-autofocus /></Modal>));
    expect(document.activeElement).toBe(el.querySelector('input'));
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => root.render(<Modal open busy title="T" onClose={onClose}><input data-autofocus /></Modal>));
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => root.render(<Modal open={false} title="T" onClose={onClose}>x</Modal>));
    expect(document.activeElement).toBe(opener);
  });
});

describe('ResourceTable', () => {
  it('makes clickable rows keyboard-activatable and labels checkboxes', () => {
    const onRowClick = vi.fn();
    const { el } = mount(
      <ResourceTable columns={[{ key: 'a', header: 'A', render: (r: { id: string }) => r.id }]} rows={[{ id: 'x1' }]} rowKey={(r) => r.id}
        onRowClick={onRowClick} rowLabel={(r) => `Select order ${r.id}`}
        selection={{ selectedKeys: new Set(), onToggle: () => {}, onToggleAllVisible: () => {} }} />,
    );
    const tr = el.querySelector('tbody tr')!;
    expect(tr.getAttribute('tabindex')).toBe('0');
    act(() => { tr.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(onRowClick).toHaveBeenCalledTimes(1);
    expect(el.querySelector('tbody input')!.getAttribute('aria-label')).toBe('Select order x1');
  });
});
