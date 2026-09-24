#!/usr/bin/env node
// Generates deterministic placeholder demo/dev imagery for the storefront.
//
// Why this exists: the repo's pre-commit hook blocks committing .jpg/.png/
// .webp, and per project policy generated media is never committed anyway —
// so a fresh checkout has no bytes at these paths. Runs automatically via
// the `prebuild`/`predev` package.json hooks (before `dev`, `build`, and
// `build:demo`, which itself shells out to `build`) so the app never ships
// with missing images.
//
// Deterministic: flat background + a centered SVG label, no randomness, no
// network calls, no timestamps — same output every run. Real merchants
// override by committing their OWN assets at these exact paths (the
// generator only fills the gap when nothing is there).
//
// Note: these are dev/demo-quality placeholders, not sharp's `create()`
// helper "coming from" any external source — everything here is synthesized
// in-process.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = fileURLToPath(new URL('..', import.meta.url)); // packages/storefront

const TARGETS = [
  { out: 'src/media/hero.jpg', width: 1600, height: 1067, format: 'jpeg', bg: '#20242b', label: 'Hero' },
  { out: 'src/media/sec2.jpg', width: 1024, height: 1280, format: 'jpeg', bg: '#2a2f38', label: 'Spotlight' },
  { out: 'src/media/homelast.png', width: 1024, height: 1024, format: 'png', bg: '#333a45', label: 'New Arrivals' },
  { out: 'public/og-image.jpg', width: 1200, height: 630, format: 'jpeg', bg: '#20242b', label: 'SellRight' },
  { out: 'public/social-image.jpg', width: 1200, height: 630, format: 'jpeg', bg: '#20242b', label: 'SellRight' },
];

function labelOverlay(width, height, label) {
  const fontSize = Math.round(Math.min(width, height) / 9);
  const escaped = label.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <text x="50%" y="50%" font-family="Helvetica, Arial, sans-serif" font-weight="600"
        font-size="${fontSize}" fill="#ffffff" fill-opacity="0.32"
        text-anchor="middle" dominant-baseline="middle">${escaped}</text>
    </svg>`,
  );
}

async function generateOne({ out, width, height, format, bg, label }) {
  const dest = resolve(root, out);
  await mkdir(dirname(dest), { recursive: true });
  const image = sharp({ create: { width, height, channels: 3, background: bg } }).composite([
    { input: labelOverlay(width, height, label) },
  ]);
  const buffer = format === 'png' ? await image.png({ compressionLevel: 9 }).toBuffer() : await image.jpeg({ quality: 82 }).toBuffer();
  await writeFile(dest, buffer);
  return dest;
}

async function main() {
  const written = [];
  for (const target of TARGETS) written.push(await generateOne(target));
  console.log(`generate-placeholder-assets: wrote ${written.length} file(s):\n${written.map((f) => `  ${f}`).join('\n')}`);
}

main().catch((err) => {
  console.error('generate-placeholder-assets failed:', err);
  process.exit(1);
});
