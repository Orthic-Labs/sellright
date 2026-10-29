/**
 * Server-only postal lookup via Qwik server$(). The US ZIP dataset is bundled into the SERVER chunk only, never
 * shipped to the client, and GB/IN/other lookups call their APIs from the server, so the browser only talks to its
 * own origin. .tsx extension is intentional so the Qwik Optimizer processes server$() correctly (a plain .ts file
 * can fail to bundle server$() correctly).
 *
 * The lookup itself lives in postal-lookup-core.ts (no Qwik import, unit-testable directly); this file only wires
 * the bundled dataset + server$ boundary around it. The demo wrapper admits this function by its symbol name
 * (deploy/demo/interactive-policy.mjs storefrontServerFunctions).
 */
import { server$ } from '@qwik.dev/router';
import usZipData from '../data/us-postal-codes.json';
import { lookupPostal, type PostalLookupResult } from './postal-lookup-core';

const zipDb = usZipData as Record<string, string[]>;

export type { PostalLookupResult };

export const lookupPostalServer = server$(function (countryCode: string, postal: string): Promise<PostalLookupResult | null> {
	return lookupPostal(String(countryCode ?? ''), String(postal ?? ''), { zipDb });
});
