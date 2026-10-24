import { describe, expect, it } from 'vitest';
import { ApiError } from '../api';
import { retryRead } from './query-retry';

describe('retryRead', () => {
  it('retries a network failure or a 5xx/408/429 once', () => {
    for (const e of [new TypeError('Failed to fetch'), new ApiError(500, 'x'), new ApiError(503, 'x'), new ApiError(408, 'x'), new ApiError(429, 'x')]) {
      expect(retryRead(0, e)).toBe(true);
      expect(retryRead(1, e)).toBe(false);
    }
  });
  it('never retries a 4xx answer or an aborted read', () => {
    for (const e of [new ApiError(400, 'x'), new ApiError(401, 'x'), new ApiError(403, 'x'), new ApiError(404, 'x'), new ApiError(409, 'x'), new DOMException('aborted', 'AbortError')]) {
      expect(retryRead(0, e)).toBe(false);
    }
  });
});
