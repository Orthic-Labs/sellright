import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PACKAGE_ROOT, loadLayers } from './check-imports.mjs';
import { checkPublicSurface, surfaceFindings } from './check-public-surface.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-public-surface.mjs');
const layers = loadLayers();

const surface = (text, reexports = layers.platformApi.reexports) =>
  surfaceFindings({ relFile: 'src/platform/views.ts', text, reexports, isPlatformSpecifier: (s) => s.startsWith('~/platform/') || s.startsWith('./') }).map((f) => f.message);

test('the real public modules (~/platform/views, ~/platform/head) are clean', () => {
  const r = checkPublicSurface({ root: PACKAGE_ROOT, layers });
  assert.deepEqual(r.findings, []);
  assert.equal(r.checked, 2);
});

test('CLI passes on the real tree', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /2 public module\(s\) clean/);
});

test('positives: the PR1 exports are allowed (Link, OptimizedImage, RichContent, TurnstileMount, formatMoney, types)', () => {
  assert.deepEqual(surface("export { Link } from '@qwik.dev/router';"), []);
  assert.deepEqual(surface("export { OptimizedImage } from '~/components/ui/LazyImage';"), []);
  assert.deepEqual(surface("export { RichContent } from '~/platform/widgets/RichContent';"), []);
  assert.deepEqual(surface("export { TurnstileMount } from '~/platform/widgets/TurnstileMount';"), []);
  assert.deepEqual(surface("import { formatPrice } from '~/utils';\nexport const formatMoney = (c: number) => formatPrice(c);"), []);
  assert.deepEqual(surface("export type { SanitizedHtml } from '~/platform/sanitized';\nexport interface A { b: string }\nexport type C = string;"), []);
  assert.deepEqual(surface("import type { QRL } from '@qwik.dev/core';\nexport type Action = QRL<() => void>;"), []);
  assert.deepEqual(surface("export { analyticsCsp, resolveHead } from './head-resolve';"), []);
});

test('negatives: a re-exported context, service, provider, loader or hook is a finding', () => {
  for (const [text, what] of [
    ["export { useCart } from '~/contexts/CartContext';", 'useCart'],
    ["export { CartService } from '~/services/CartService';", 'CartService'],
    ["export { getBlogPosts } from '~/providers/shop/blog/blog';", 'getBlogPosts'],
    ["export { useStoreIdentityLoader } from '~/routes/layout';", 'useStoreIdentityLoader'],
    ["export { APP_STATE } from '~/constants';", 'APP_STATE'],
    ["export { useContext } from '@qwik.dev/core';", 'useContext'],
    ["export * from '~/contexts/CartContext';", 'export *'],
    ["export * as ctx from '~/contexts/CartContext';", 'export * as'],
    ["import { useCart } from '~/contexts/CartContext';\nexport { useCart };", 'useCart'],
    ["import { useCart as hook } from '~/contexts/CartContext';\nexport { hook as useCartHook };", 'useCartHook'],
    ["import Svc from '~/services/Svc';\nexport default Svc;", 'default export'],
  ]) {
    assert.ok(surface(text).length > 0, `${what} must be flagged: ${text}`);
  }
});

test('a listed re-export is accepted only from its own source module (name and source must both match)', () => {
  assert.ok(surface("export { Link } from '@qwik.dev/router';").length === 0);
  assert.ok(surface("export { Link } from 'react-router';").length > 0, 'right name, wrong source');
  assert.ok(surface("export { Navigate } from '@qwik.dev/router';").length > 0, 'right source, unlisted name');
  assert.ok(surface("export { OptimizedImage } from '~/components/ui';").length > 0, 'the LazyImage module is the reviewed target');
});

test('type-only re-exports of anything are fine (erased)', () => {
  assert.deepEqual(surface("export type { CartContextState } from '~/contexts/CartContext';"), []);
  assert.deepEqual(surface("export { type CartContextState } from '~/contexts/CartContext';"), []);
});
