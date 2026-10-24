import { useEffect, useState } from 'react';

/** Search typing waits this long after the last keystroke before it asks the API (#362). */
export const SEARCH_DEBOUNCE_MS = 300;

/** `value`, updated only once it has stayed unchanged for `ms`. */
export function useDebouncedValue<T>(value: T, ms = SEARCH_DEBOUNCE_MS): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}
