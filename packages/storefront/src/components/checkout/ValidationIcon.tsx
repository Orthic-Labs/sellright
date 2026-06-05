import { component$, useSignal } from '@qwik.dev/core';

interface ValidationIconProps {
  touched: boolean;
  error: string;
  valid: boolean;
}

/**
 * Inline validation icon — positioned inside input field by parent (relative wrapper).
 * - Untouched: nothing
 * - Touched + valid: green check
 * - Touched + error: red x — hover (desktop) shows tooltip, tap (mobile) shows inline text below
 */
export const ValidationIcon = component$<ValidationIconProps>(({ touched, error, valid }) => {
  const showTooltip = useSignal(false);
  const showInlineError = useSignal(false);

  if (!touched) return null;

  if (valid) {
    return (
      <div class="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none">
        <svg class="w-4 h-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7" />
        </svg>
      </div>
    );
  }

  if (error) {
    return (
      <>
        {/* Icon inside field */}
        <div
          class="absolute right-3 top-1/2 -translate-y-1/2 cursor-pointer z-10"
          onMouseEnter$={() => { showTooltip.value = true; }}
          onMouseLeave$={() => { showTooltip.value = false; }}
          onClick$={() => { showInlineError.value = !showInlineError.value; }}
        >
          <svg class="w-4 h-4 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="9" stroke-width="2" />
            <path stroke-linecap="round" stroke-width="2" d="M15 9l-6 6M9 9l6 6" />
          </svg>

          {/* Desktop hover tooltip */}
          {showTooltip.value && (
            <div class="hidden md:block absolute right-0 top-full mt-1.5 z-50 bg-[#1a1a1a] text-white text-[11px] leading-tight px-2.5 py-1.5 rounded whitespace-nowrap shadow-lg">
              {error}
              <div class="absolute -top-1 right-2 w-2 h-2 bg-[#1a1a1a] rotate-45" />
            </div>
          )}
        </div>

        {/* Mobile inline error — shown on tap */}
        {showInlineError.value && (
          <p class="md:hidden mt-1 text-[11px] text-red-500 leading-tight">{error}</p>
        )}
      </>
    );
  }

  return null;
});
