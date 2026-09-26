/**
 * Server-only US ZIP lookup via Qwik server$(). The JSON dataset is bundled
 * into the SERVER chunk only — never shipped to the client. .tsx extension is
 * intentional so the Qwik Optimizer processes server$() correctly (a plain
 * .ts file can fail to bundle server$() correctly).
 *
 * The matching algorithm itself lives in postal-lookup-us.ts (no Qwik import,
 * unit-testable directly); this file only wires the bundled dataset + server$
 * boundary around it.
 */
import { server$ } from '@qwik.dev/router';
import usZipData from '../data/us-postal-codes.json';
import { matchUsZip, type PostalLookupResult } from './postal-lookup-us';

const zipDb = usZipData as Record<string, string[]>;

export type { PostalLookupResult };

export const lookupUsPostalServer = server$(function (postal: string): PostalLookupResult | null {
	return matchUsZip(zipDb, postal);
});
