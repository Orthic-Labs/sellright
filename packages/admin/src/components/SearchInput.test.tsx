// @vitest-environment jsdom
// SearchInput debounces its onChange (#362): typing a word is one search, not one per keystroke.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { SearchInput } from './ui';
import { SEARCH_DEBOUNCE_MS } from '../lib/debounce';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('SearchInput', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ''; });

  it('reports the text once typing pauses, and an outside value replaces the text', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = vi.fn();
    act(() => { root.render(<SearchInput value="" onChange={onChange} placeholder="Search" />); });
    const input = container.querySelector('input')!;
    for (const v of ['s', 'sh', 'shi', 'shir', 'shirt']) {
      act(() => { type(input, v); });
      act(() => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 50); });
    }
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe('shirt');
    act(() => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS); });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('shirt');

    act(() => { root.render(<SearchInput value="" onChange={onChange} placeholder="Search" />); });
    expect(input.value).toBe('shirt'); // the page has not cleared it: our own emit is not an outside change
    act(() => { root.render(<SearchInput value="cleared" onChange={onChange} placeholder="Search" />); });
    expect(input.value).toBe('cleared');
    act(() => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2); });
    expect(onChange).toHaveBeenCalledTimes(1);
    act(() => { root.unmount(); });
  });
});
