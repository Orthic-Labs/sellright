/** Per-IP throttle for review submissions (shared backend, see auth/rate-limit-backend.ts). */
import { rateLimitBackend } from '../auth/rate-limit-backend.js';

const HOUR = 60 * 60 * 1000;
export const reviewRetryAfter = (ip: string): Promise<number> => rateLimitBackend().check('review-submit', ip, HOUR, 10);
export const recordReviewAttempt = (ip: string): Promise<void> => rateLimitBackend().recordFailure('review-submit', ip, HOUR);
