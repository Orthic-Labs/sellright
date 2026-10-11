#!/usr/bin/env node
// Removes the storefront build outputs. Replaces the former inline eval one-liner clean script so the build chain has no
// eval code. Targets are fixed; an optional first argument overrides the package root (used by the test).
import { rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLEAN_TARGETS = ['dist', 'server', '.cache'];

export function clean(root) {
  for (const target of CLEAN_TARGETS) rmSync(join(root, target), { recursive: true, force: true });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  clean(resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..')));
}
