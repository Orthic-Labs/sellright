/**
 * Server-only US ZIP lookup via Qwik server$().
 * The JSON import is bundled into the SERVER chunk only — never shipped to client.
 * .tsx extension is intentional: ensures Qwik Optimizer processes this file (plain
 * .ts can fail to bundle server$() correctly — see memory `feedback_server_dollar_in_tsx`).
 */
import { server$ } from '@qwik.dev/router';
import usZipData from '../data/us-postal-codes.json';

const zipDb = usZipData as Record<string, string[]>;

export interface PostalLookupResult {
  city: string;
  province: string;
}

export const lookupUsPostalServer = server$(function (
  postal: string,
): PostalLookupResult | null {
  const cleaned = postal.replace(/[^0-9]/g, '');
  // Strict US ZIP: exactly 5 digits (basic) or 9 digits (ZIP+4). Anything else is not a valid
  // US postal — silently truncating would return a ghost match (e.g. Indian PIN "400091" would
  // become "40009" which is a real US ZIP). Fail closed instead.
  if (cleaned.length !== 5 && cleaned.length !== 9) return null;
  const entry = zipDb[cleaned.slice(0, 5)];
  if (!entry || entry.length < 2) return null;
  return { city: entry[0], province: entry[1] };
});
