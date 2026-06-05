import { component$, useSignal, useTask$, useOnWindow, $, type QRL } from '@qwik.dev/core';

interface QuantityDropdownProps {
  id: string;
  value: number;
  options: (number | string)[];
  disabled?: boolean;
  theme?: 'dark' | 'light';
  onChange$: QRL<(value: number | string, id: string) => void>;
}

export const QuantityDropdown = component$<QuantityDropdownProps>((props) => {
  const isDarkTheme = props.theme !== 'light';
  const isOpen = useSignal(false);
  const dropdownRef = useSignal<HTMLDivElement>();
  const selectedIndex = useSignal(0);

  useTask$(({ track }) => {
    const currentValue = track(() => props.value);
    const currentOptions = track(() => props.options);
    const index = currentOptions.indexOf(currentValue);
    selectedIndex.value = index >= 0 ? index : 0;
  });

  useTask$(({ track }) => {
    const currentDisabled = track(() => props.disabled);
    if (currentDisabled && isOpen.value) {
      isOpen.value = false;
    }
  });

  // T22: click-outside via useOnWindow (centralized pattern)
  useOnWindow('click', $((event: Event) => {
    if (!isOpen.value) return;
    if (dropdownRef.value && !dropdownRef.value.contains(event.target as Node)) {
      isOpen.value = false;
    }
  }));

  const toggleDropdown = $(() => {
    if (!props.disabled) {
      isOpen.value = !isOpen.value;
    }
  });

  const handleOptionSelect = $((option: number | string) => {
    props.onChange$(option, props.id);
    if (option !== "10+") {
      isOpen.value = false;
    }
  });

  const handleKeyDown = $((event: KeyboardEvent) => {
    if (props.disabled) return;
    switch (event.key) {
      case 'Enter':
      case ' ':
        if (!isOpen.value) {
          isOpen.value = true;
        } else {
          handleOptionSelect(props.options[selectedIndex.value]);
        }
        break;
      case 'Escape':
        isOpen.value = false;
        break;
      case 'ArrowDown':
        if (!isOpen.value) {
          isOpen.value = true;
        } else {
          selectedIndex.value = Math.min(selectedIndex.value + 1, props.options.length - 1);
        }
        break;
      case 'ArrowUp':
        if (!isOpen.value) {
          isOpen.value = true;
        } else {
          selectedIndex.value = Math.max(selectedIndex.value - 1, 0);
        }
        break;
      case 'Tab':
        isOpen.value = false;
        break;
    }
  });

  return (
    <div class="relative inline-block" ref={dropdownRef}>
      <button
        id={props.id}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={isOpen.value}
        aria-disabled={props.disabled}
        disabled={props.disabled}
        onClick$={toggleDropdown}
        preventdefault:keydown
        onKeyDown$={handleKeyDown}
        class={[
          'relative inline-flex items-center justify-center gap-4',
          'w-full min-w-[80px] min-h-[44px]',
          'py-1.5 px-3',
          'border border-[rgba(140,107,58,0.3)] rounded-md',
          isDarkTheme
            ? 'bg-[rgba(255,255,255,0.05)]'
            : 'bg-[rgba(255,255,255,1)]',
          isDarkTheme
            ? 'text-base sm:text-sm leading-5 font-medium text-[rgba(253,250,246,0.65)] text-center'
            : 'text-base sm:text-sm leading-5 font-medium text-[rgba(26,26,26,0.78)] text-center',
          'shadow-none',
          !props.disabled && (isDarkTheme
            ? 'focus:outline-hidden focus:ring-1 focus:ring-[rgba(253,250,246,0.3)] focus:border-[rgba(140,107,58,0.45)]'
            : 'focus:outline-hidden focus:ring-1 focus:ring-[rgba(140,107,58,0.2)] focus:border-[rgba(140,107,58,0.45)]'),
          !props.disabled && 'hover:border-[rgba(140,107,58,0.45)] cursor-pointer',
          props.disabled && 'opacity-50 cursor-not-allowed',
          'transition-all duration-200'
        ].filter(Boolean).join(' ')}
      >
        <span>{props.value}</span>
        <svg
          class={`w-4 h-4 transition-transform duration-200 ${isOpen.value ? 'transform rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
        </svg>
      </button>

      {isOpen.value && (
        <ul
          role="listbox"
          aria-labelledby={props.id}
          aria-activedescendant={`${props.id}-option-${selectedIndex.value}`}
          class={`absolute z-50 w-full top-full mt-1 border border-[rgba(140,107,58,0.3)] rounded-md shadow-lg max-h-[240px] overflow-y-auto ${isDarkTheme ? 'bg-[#141210]' : 'bg-[#FFFFFF]'}`}
          style={{ animation: 'fadeIn 0.15s ease-out' }}
        >
          {props.options.map((option, index) => {
            const isSelected = props.value === option;
            const isHighlighted = selectedIndex.value === index;

            return (
              <li
                key={`${props.id}-${option}`}
                id={`${props.id}-option-${index}`}
                role="option"
                aria-selected={isSelected}
                tabIndex={-1}
                onClick$={() => handleOptionSelect(option)}
                onMouseEnter$={() => { selectedIndex.value = index; }}
                class={[
                  'w-full px-3 py-2.5',
                  'text-center',
                  'text-base sm:text-sm font-medium',
                  isDarkTheme
                    ? isSelected && 'bg-[rgba(253,250,246,0.14)] text-[#FDFAF6] font-semibold'
                    : isSelected && 'bg-[rgba(20,18,16,0.06)] text-[#1A1A1A] font-semibold',
                  isDarkTheme
                    ? !isSelected && 'text-[rgba(253,250,246,0.7)]'
                    : !isSelected && 'text-[rgba(26,26,26,0.72)]',
                  isDarkTheme
                    ? isHighlighted && !isSelected && 'bg-[rgba(253,250,246,0.08)]'
                    : isHighlighted && !isSelected && 'bg-[rgba(20,18,16,0.04)]',
                  isDarkTheme
                    ? 'cursor-pointer hover:bg-[rgba(253,250,246,0.08)]'
                    : 'cursor-pointer hover:bg-[rgba(20,18,16,0.04)]',
                  'transition-colors duration-150'
                ].filter(Boolean).join(' ')}
              >
                {option}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
});
