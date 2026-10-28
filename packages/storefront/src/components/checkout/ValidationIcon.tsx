import { component$ } from '@qwik.dev/core';

interface ValidationIconProps {
  touched: boolean;
  error: string;
  valid: boolean;
}

/**
 * Inline validation icon, positioned inside the input by its parent (a `relative` wrapper around the input only).
 * - Untouched: nothing
 * - Touched + valid: green check
 * - Touched + error: red x. Decorative: the message itself is the visible `FieldError` under the field.
 */
export const ValidationIcon = component$<ValidationIconProps>(({ touched, error, valid }) => {
  if (!touched) return null;

  if (valid) {
    return (
      <div class="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true">
        <svg class="w-4 h-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7" />
        </svg>
      </div>
    );
  }

  if (error) {
    return (
      <div class="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true">
        <svg class="w-4 h-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="9" stroke-width="2" />
          <path stroke-linecap="round" stroke-width="2" d="M15 9l-6 6M9 9l6 6" />
        </svg>
      </div>
    );
  }

  return null;
});

/**
 * The visible error message under a field, on every screen size (#407). The input points at it with
 * `aria-describedby={id}` and `aria-invalid`; `role="alert"` announces it when it appears.
 */
export const FieldError = component$<{ id?: string; message?: string }>(({ id, message }) => {
  if (!id || !message) return null;
  return (
    <p id={id} role="alert" class="mt-1 text-[12px] leading-snug text-[#b42318]">
      {message}
    </p>
  );
});
