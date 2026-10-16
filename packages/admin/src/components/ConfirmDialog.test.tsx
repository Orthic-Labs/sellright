// @vitest-environment jsdom
// Shared ConfirmDialog — the replacement for window.confirm(...) call sites
// (Orders.tsx bulk-purge, OrderDetail.tsx cancel/refund). Mirrors
// ResourceTable.test.tsx's mount/act/unmount pattern (no @testing-library in
// this repo's admin package).
import { describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { ReactNode } from 'react';
import { ConfirmDialog, useConfirmDialog } from './ConfirmDialog.js';
import { useEffect } from 'react';

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

describe('ConfirmDialog', () => {
  it('renders nothing when closed', () => {
    const { container, root } = mount(
      <ConfirmDialog open={false} title="Delete?" onConfirm={() => {}} onCancel={() => {}} />,
    );
    try {
      expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    } finally { unmount(container, root); }
  });

  it('renders the title/description and an accessible alertdialog role when open', () => {
    const { container, root } = mount(
      <ConfirmDialog open title="Cancel order SR-1?" description="Stock will be released." onConfirm={() => {}} onCancel={() => {}} />,
    );
    try {
      const dialog = container.querySelector('[role="alertdialog"]');
      expect(dialog).not.toBeNull();
      expect(dialog?.getAttribute('aria-modal')).toBe('true');
      expect(container.textContent).toContain('Cancel order SR-1?');
      expect(container.textContent).toContain('Stock will be released.');
    } finally { unmount(container, root); }
  });

  it('calls onConfirm when the confirm button is clicked, and onCancel for the cancel button', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { container, root } = mount(
      <ConfirmDialog open title="Delete?" confirmLabel="Delete permanently" onConfirm={onConfirm} onCancel={onCancel} />,
    );
    try {
      const buttons = Array.from(container.querySelectorAll('button'));
      const confirmBtn = buttons.find((b) => b.textContent === 'Delete permanently')!;
      const cancelBtn = buttons.find((b) => b.textContent === 'Cancel')!;
      act(() => { confirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect(onConfirm).toHaveBeenCalledTimes(1);
      act(() => { cancelBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect(onCancel).toHaveBeenCalledTimes(1);
    } finally { unmount(container, root); }
  });

  it('calls onCancel on Escape', () => {
    const onCancel = vi.fn();
    const { container, root } = mount(
      <ConfirmDialog open title="Delete?" onConfirm={() => {}} onCancel={onCancel} />,
    );
    try {
      act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
      expect(onCancel).toHaveBeenCalledTimes(1);
    } finally { unmount(container, root); }
  });

  it('confines Tab, Shift+Tab, and focus to the dialog, then restores prior focus on close', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const props = { title: 'Delete?', onConfirm: () => {}, onCancel: () => {} };
    const { container, root } = mount(<ConfirmDialog open {...props} />);
    try {
      const [cancel, confirm] = Array.from(container.querySelectorAll('button'));
      expect(document.activeElement).toBe(confirm);

      act(() => { cancel.focus(); });
      act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })); });
      expect(document.activeElement).toBe(confirm);
      act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })); });
      expect(document.activeElement).toBe(cancel);

      act(() => { opener.focus(); });
      expect(container.querySelector('[role="alertdialog"]')?.contains(document.activeElement)).toBe(true);

      act(() => { root.render(<ConfirmDialog open={false} {...props} />); });
      expect(document.activeElement).toBe(opener);
    } finally {
      unmount(container, root);
      opener.remove();
    }
  });

  it('disables both buttons while loading', () => {
    const onCancel = vi.fn();
    const { container, root } = mount(
      <ConfirmDialog open title="Delete?" loading onConfirm={() => {}} onCancel={onCancel} />,
    );
    try {
      const buttons = Array.from(container.querySelectorAll('button'));
      expect(buttons.every((b) => b.disabled)).toBe(true);
      const dialog = container.querySelector('[role="alertdialog"]')!;
      expect(document.activeElement).toBe(dialog);
      act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
      expect(onCancel).not.toHaveBeenCalled();
      act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true })); });
      expect(document.activeElement).toBe(dialog);
    } finally { unmount(container, root); }
  });

  it('moves focus into dialog when focused confirm becomes disabled, then restores opener after loading ends', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const props = { title: 'Delete?', onConfirm: () => {}, onCancel: () => {} };
    const { container, root } = mount(<ConfirmDialog open {...props} />);
    try {
      const dialog = container.querySelector('[role="alertdialog"]')!;
      const confirm = container.querySelector<HTMLButtonElement>('button:last-child')!;
      expect(document.activeElement).toBe(confirm);

      act(() => { root.render(<ConfirmDialog open loading {...props} />); });
      expect(confirm.disabled).toBe(true);
      expect(document.activeElement).toBe(dialog);

      act(() => { root.render(<ConfirmDialog open {...props} />); });
      act(() => { root.render(<ConfirmDialog open={false} {...props} />); });
      expect(document.activeElement).toBe(opener);
    } finally {
      unmount(container, root);
      opener.remove();
    }
  });
});

describe('useConfirmDialog', () => {
  it('resolves true when confirmed and false when cancelled — the window.confirm() drop-in replacement', async () => {
    let confirmFn: ((opts: { title: string }) => Promise<boolean>) | null = null;
    let lastResult: boolean | null = null;

    function Harness() {
      const { confirm, dialog } = useConfirmDialog();
      useEffect(() => { confirmFn = confirm; }, [confirm]);
      return dialog;
    }

    const { container, root } = mount(<Harness />);
    try {
      let pending!: Promise<boolean>;
      act(() => { pending = confirmFn!({ title: 'Issue this refund?' }); });
      expect(container.textContent).toContain('Issue this refund?');

      const confirmBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Confirm')!;
      act(() => { confirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      lastResult = await pending;
      expect(lastResult).toBe(true);
      // Dialog is dismissed after resolving.
      expect(container.querySelector('[role="alertdialog"]')).toBeNull();

      act(() => { pending = confirmFn!({ title: 'Cancel order?' }); });
      const cancelBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Cancel')!;
      act(() => { cancelBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      lastResult = await pending;
      expect(lastResult).toBe(false);
    } finally { unmount(container, root); }
  });
});
