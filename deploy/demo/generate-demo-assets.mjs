// Generates the shared, synthetic demo-catalog product photography referenced
// by visitors.mjs (`demo-seed/<slug>.webp`, one file per seeded product,
// shared across every visitor tenant — never per-visitor). The repo's
// pre-commit hook blocks committing .jpg/.png/.webp and per project policy
// generated media is never committed, so these are rendered on disk at
// runtime instead of shipping as binaries in the repo.
//
// Deterministic: flat background + a centered SVG label, no randomness, no
// network calls. Idempotent: skips any file that already exists (called on
// every `sellright-demo` process start from interactive-server.mjs — a pm2
// restart should not repaint files a prior boot already produced).
//
// Uses the api package's own sharp dependency the same way the rest of
// deploy/demo already reaches into packages/api (e.g. `drizzle-orm` via
// createRequire in interactive-server.mjs) — deploy/demo is not a pnpm
// workspace member and has no node_modules of its own.

import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../packages/api/package.json', import.meta.url));
const sharp = require('sharp');

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
  const dir = resolve(assetDir, 'demo-seed');
  await mkdir(dir, { recursive: true });
  const written = [];
  for (const { slug, name, bg } of DEMO_SEED_PRODUCTS) {
    const dest = resolve(dir, `${slug}.webp`);
    if (existsSync(dest)) continue;
    const buffer = await sharp({ create: { width: WIDTH, height: HEIGHT, channels: 3, background: bg } })
      .composite([{ input: labelOverlay(WIDTH, HEIGHT, name) }])
      .webp({ quality: 82 })
      .toBuffer();
    await writeFile(dest, buffer);
    written.push(dest);
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
  const written = await ensureDemoSeedAssets(assetDir);
  console.log(`generate-demo-assets: wrote ${written.length} file(s) (skipped existing) under ${resolve(assetDir, 'demo-seed')}`);
}
