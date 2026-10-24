import { ApiError } from '../api';

/** React Query `retry` for reads: once, and only when a retry can help — a network failure or a 5xx/408/429 answer. A 4xx
 *  answer (signed out, forbidden, not found, invalid) is final and is not sent again; an aborted read is not retried
 *  (#362). Mutations keep React Query's default: no retry. */
export function retryRead(failureCount: number, error: unknown): boolean {
  if (failureCount >= 1) return false;
  if (error instanceof ApiError) return error.status >= 500 || error.status === 408 || error.status === 429;
  return !(error instanceof DOMException && error.name === 'AbortError');
}
