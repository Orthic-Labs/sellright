// Generates the shared, synthetic demo-catalog product photography referenced
// by visitors.mjs (`demo-seed/<slug>.webp`, one file per seeded product,
// shared across every visitor tenant — never per-visitor). The repo's
// pre-commit hook blocks committing .jpg/.png/.webp and per project policy
// generated media is never committed, so these are rendered on disk at
// runtime instead of shipping as binaries in the repo.
//
// Deterministic: flat background + a centered SVG label, no randomness, no
// network calls. Idempotent: called on every `sellright-demo` process start
// from interactive-server.mjs (a pm2 restart should not repaint files a
// prior boot already produced) AND safe if two processes race to create the
// same file. Idempotency and race-safety both come from a single exclusive
// write (`wx`) with EEXIST caught and treated as "already there" — there is
// deliberately no separate existsSync-then-write check (that would be a
// TOCTOU race; CodeQL js/file-system-race flags exactly that pattern, and
// flags it purely from a check and a write sharing a path, regardless of
// what flag the write itself uses — so the check has to not exist at all,
// not just be made harmless).
//
// Uses the api package's own sharp dependency the same way the rest of
// deploy/demo already reaches into packages/api (e.g. `drizzle-orm` via
// createRequire in interactive-server.mjs) — deploy/demo is not a pnpm
// workspace member and has no node_modules of its own.
//
// Loaded lazily/optionally: the CI lane that syntax-checks this file
// (`node --check` + `node --test deploy/demo/*.test.mjs`, see
// .github/workflows/ci.yml's "storefront" job) never runs `pnpm install` —
// it's deliberately dependency-free — so packages/api/node_modules/sharp
// doesn't exist there. Falling back to a no-op keeps that job fast and
// dependency-free while still exercising every other invariant (the real
// pixel-output tests only run where sharp IS installed, e.g. `pnpm verify`).

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

let sharp = null;
try {
  const require = createRequire(new URL('../../packages/api/package.json', import.meta.url));
  sharp = require('sharp');
} catch {
  // Not installed in this environment — ensureDemoSeedAssets becomes a no-op.
}

/** True when packages/api's sharp dependency was resolvable — gates both
 *  ensureDemoSeedAssets' actual rendering and the pixel-output assertions in
 *  generate-demo-assets.test.mjs. */
export const sharpAvailable = sharp !== null;

// Mirrors the product list seeded in visitors.mjs (`provisionVisitor`) — keep
// slugs/names/colors in sync if that list ever changes.
export const DEMO_SEED_PRODUCTS = [
  { slug: 'studio-notebook', name: 'Studio Notebook', bg: '#3f4a3d' },
  { slug: 'everyday-tote', name: 'Everyday Tote', bg: '#4a4438' },
  { slug: 'stoneware-cup', name: 'Stoneware Cup', bg: '#3d4348' },
  { slug: 'desk-tray', name: 'Desk Tray', bg: '#4a3a3d' },
];

const WIDTH = 1000;
const HEIGHT = 1250;

function labelOverlay(width, height, label) {
  const fontSize = Math.round(width / 9);
  const escaped = label.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <text x="50%" y="50%" font-family="Helvetica, Arial, sans-serif" font-weight="600"
        font-size="${fontSize}" fill="#ffffff" fill-opacity="0.32"
        text-anchor="middle" dominant-baseline="middle">${escaped}</text>
    </svg>`,
  );
}

/** Renders demo-seed/<slug>.webp for every seeded product into `assetDir` if
 *  missing. Non-fatal by design at the call site — a rendering failure
 *  should not prevent the demo API from serving traffic; it just means the
 *  built-in icon placeholder shows until the next successful boot. */
export async function ensureDemoSeedAssets(assetDir) {
  if (!sharp) return [];
  const dir = resolve(assetDir, 'demo-seed');
  await mkdir(dir, { recursive: true });
  const written = [];
  for (const { slug, name, bg } of DEMO_SEED_PRODUCTS) {
    const dest = resolve(dir, `${slug}.webp`);
    const buffer = await sharp({ create: { width: WIDTH, height: HEIGHT, channels: 3, background: bg } })
      .composite([{ input: labelOverlay(WIDTH, HEIGHT, name) }])
      .webp({ quality: 82 })
      .toBuffer();
    try {
      // Exclusive create — throws EEXIST instead of silently overwriting, so
      // a file from a prior boot (or a concurrently racing one) is left
      // alone rather than clobbered or partially rewritten.
      await writeFile(dest, buffer, { flag: 'wx' });
      written.push(dest);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  return written;
}

// Runnable standalone: `node generate-demo-assets.mjs <assetDir>` (used by
// the test suite and available for manual/CI regeneration).
if (import.meta.url === `file://${process.argv[1]}`) {
  const assetDir = process.argv[2];
  if (!assetDir) {
    console.error('Usage: node generate-demo-assets.mjs <assetDir>');
    process.exit(1);
  }
  if (!sharpAvailable) {
    console.error('generate-demo-assets: sharp is not installed (packages/api/node_modules) — nothing to do.');
    process.exit(1);
  }
  const written = await ensureDemoSeedAssets(assetDir);
  console.log(`generate-demo-assets: wrote ${written.length} file(s) (skipped existing) under ${resolve(assetDir, 'demo-seed')}`);
}
