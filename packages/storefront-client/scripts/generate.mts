/**
 * Run via `pnpm generate` / `pnpm generate:check` (tsx, see package.json) —
 * generates this package's types FROM the API's own OpenAPI contract, never
 * hand-duplicated. Two steps:
 *
 *   1. Boot the real Hono app in-process (no server socket needed —
 *      `app.request()` runs the whole middleware/route chain against an
 *      in-memory Request/Response, including the `.doc('/v1/openapi.json',
 *      ...)` route app.ts registers) and dump its OpenAPI document.
 *   2. Feed that document straight into openapi-typescript's Node API and
 *      write the resulting `.d.ts`.
 *
 * `pnpm generate` writes both `openapi.json` (the spec snapshot, committed
 * so a diff shows exactly what contract changed) and `src/generated/
 * schema.d.ts`. `pnpm generate:check` (--check) does the same generation
 * into a temp location and fails if it differs from what's committed — the
 * CI gate that keeps this package from silently drifting from the API.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import openapiTS, { astToString } from 'openapi-typescript';

const CHECK = process.argv.includes('--check');
const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, '..');
// Cross-package relative import (dev-only: this script never ships — see
// package.json's `generate`/`generate:check` scripts, both tsx/dev-time
// only). Although @sellright/api has exported library entry points, this
// generator needs its live OpenAPI document; importing app.ts directly lets
// it call app.request() without standing up a real HTTP server in CI.
const API_APP_ENTRY = join(PKG_ROOT, '..', 'api', 'src', 'app.ts');

async function dumpOpenApiDocument(): Promise<Record<string, unknown>> {
  const { createApp } = (await import(API_APP_ENTRY)) as { createApp: () => { request: (path: string) => Promise<Response> } };
  const app = createApp();
  const res = await app.request('/v1/openapi.json');
  if (!res.ok) throw new Error(`GET /v1/openapi.json returned ${res.status}`);
  // The access-log middleware writes one JSON line to stdout per request
  // (see lib/request-id.ts) — this script only wants the response BODY, so
  // read it directly rather than via any captured stdout.
  return (await res.json()) as Record<string, unknown>;
}

async function generate(): Promise<{ openapiJson: string; schemaDts: string }> {
  const document = await dumpOpenApiDocument();
  const openapiJson = JSON.stringify(document, null, 2) + '\n';
  const ast = await openapiTS(document as never, {
    // Every response is fully typed via zod-openapi — no `unknown` escape
    // hatch needed for an undocumented shape.
    alphabetize: true,
  });
  const schemaDts = astToString(ast);
  return { openapiJson, schemaDts };
}

async function main() {
  const fresh = await generate();

  if (!CHECK) {
    await writeFile(join(PKG_ROOT, 'openapi.json'), fresh.openapiJson);
    await writeFile(join(PKG_ROOT, 'src', 'generated', 'schema.d.ts'), fresh.schemaDts);
    console.log('storefront-client: generated openapi.json + src/generated/schema.d.ts');
    return;
  }

  const committedJson = await readFile(join(PKG_ROOT, 'openapi.json'), 'utf8').catch(() => '');
  const committedDts = await readFile(join(PKG_ROOT, 'src', 'generated', 'schema.d.ts'), 'utf8').catch(() => '');
  const jsonOk = committedJson === fresh.openapiJson;
  const dtsOk = committedDts === fresh.schemaDts;
  if (jsonOk && dtsOk) {
    console.log('storefront-client: generated output is up to date.');
    return;
  }
  console.error('storefront-client: generated output is STALE. Run `pnpm --filter @sellright/storefront-client generate` and commit the result.');
  if (!jsonOk) console.error("  - openapi.json differs from the API's current /v1/openapi.json");
  if (!dtsOk) console.error('  - src/generated/schema.d.ts differs from a fresh openapi-typescript run');
  process.exitCode = 1;
}

await main();
